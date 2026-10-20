import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { computeTax, estimateExpansionCapex, fundingCheck, navBridge, normalizeProject, npv, parseNumber, perShare, runAll, simulate, validateProject } from '../src/engine.mjs';

const readJson = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const example = normalizeProject(readJson('../examples/global-atomic-dasa.json'));
const reference = readJson('./fixtures/excel-reference.json');

// The workbook hand-picks the tax holiday and the opening deduction for each price sheet.
const taxByPrice = {
    110: { holidayYears: 3, openingPool: 37 },
    130: { holidayYears: 2, openingPool: 194 },
    150: { holidayYears: 2, openingPool: 65 },
    170: { holidayYears: 1, openingPool: 526 },
};
const scenario1200 = example.scenarios.find((scenario) => scenario.name === '1200 tpd');

const close = (actual, expected, label, tolerance = 1e-6) => {
    assert.ok(Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected)), `${label}: got ${actual}, expected ${expected}`);
};

for (const [priceKey, expected] of Object.entries(reference)) {
    test(`matches the Excel 1200 tpd block at ${priceKey} US$/lb`, () => {
        const project = { ...example, tax: { ...example.tax, ...taxByPrice[priceKey] } };
        const simulation = simulate(project, scenario1200, Number(priceKey));
        close(simulation.totals.revenue, expected.revenue, 'revenue');
        close(simulation.totals.ebitda, expected.ebitda, 'ebitda');
        close(simulation.totals.tax, expected.taxes, 'taxes');
        close(simulation.totals.postTaxCashFlow, expected.postTax, 'post-tax cash flow');
        for (const rate of [8, 10, 12]) {
            const result = npv(project, scenario1200, simulation, rate / 100);
            close(result.project100, expected.npv100[rate], `NPV ${rate}% (100%)`);
            close(result.attributable, expected.npvCompany[rate], `NPV ${rate}% (company 80%)`);
        }
    });
}

test('base plan reproduces the Excel base block (110 US$/lb, pool 100)', () => {
    const project = { ...example, tax: { rate: 0.3, holidayYears: 3, openingPool: 100 } };
    const simulation = simulate(project, example.scenarios[0], 110);
    close(simulation.totals.revenue, 7227, 'revenue');
    close(simulation.totals.ebitda, 4491.48819, 'ebitda');
    close(simulation.totals.preTaxCashFlow, 4072.7981899999995, 'pre-tax cash flow');
    close(simulation.totals.tax, 990.7957607999999, 'taxes');
    close(simulation.totals.attributableCashFlow, 2465.60194336, 'company cash flow');
});

test('per-share block reproduces the Excel EPS arithmetic', () => {
    const project = { ...example, equity: { ...example.equity, peMultiples: [20, 15] } };
    const simulation = simulate(project, scenario1200, 110);
    const shares = perShare({ ...project, tax: { ...project.tax, ...taxByPrice[110] } }, simulate({ ...project, tax: { ...project.tax, ...taxByPrice[110] } }, scenario1200, 110));
    assert.equal(shares.shares, 958);
    close(shares.epsMean, shares.meanCashFlow / 958, 'eps mean');
    close(shares.targets[0].mean.target, shares.epsMean * 20, 'target at P/E 20');
    close(shares.targets[0].mean.targetLocal, shares.epsMean * 20 * 1.43, 'target in local currency');
    close(shares.targets[0].mean.returnMultiple, (shares.epsMean * 20) / 0.28, 'return multiple');
    close(shares.targets[1].reference.investmentValue, 10000 * ((shares.epsReference * 15) / 0.28), 'investment value');
    assert.ok(simulation.totals.revenue > 0);
});

test('expansion capex estimator reproduces the INCREASE IN CAPEX sheet (2000 tpd)', () => {
    const result = estimateExpansionCapex({
        capacityRatio: 2000 / 1200,
        escalation: 0.05,
        years: 3,
        items: [
            { name: 'total plant cost', baseCost: 96, exponent: 0.6 },
            { name: 'owner costs', baseCost: 66.9, exponent: 0.3 },
            { name: 'epcm', baseCost: 17.4, exponent: 0.8 },
            { name: 'mining', baseCost: 98.3, exponent: 0.9 },
            { name: 'spares', baseCost: 2.2, exponent: 0.6 },
            { name: 'dstfs', baseCost: 3.2, exponent: 0.65 },
            { name: 'surface mobile plant', baseCost: 5.7, exponent: 0.65 },
            { name: 'infrastructure', baseCost: 80.4, exponent: 0.64 },
        ],
    });
    close(result.total, 170.23246616183593, 'total delta capex');
});

test('tax: holiday, opening pool and loss carry-forward', () => {
    assert.deepEqual(computeTax([100, 100, 100, 100], { rate: 0.3, holidayYears: 2, openingPool: 40 }), [0, 0, 18, 30]);
    assert.deepEqual(computeTax([100, -50, 30, 100], { rate: 0.5, holidayYears: 0, openingPool: 0 }), [50, 0, 0, 40]);
});

test('mine closes after the last producing year', () => {
    const simulation = simulate(
        example,
        example.scenarios.find((scenario) => scenario.name === '2000 tpd'),
        110
    );
    assert.equal(simulation.lifeYears, 15);
    assert.equal(simulation.operatingCost[20], 0);
    assert.equal(simulation.sustainingCapex[20], 0);
});

test('funding check and NAV bridge add up', () => {
    const funding = fundingCheck(example, example.scenarios[3]);
    close(funding.surplus, 42.4 + 295 + 218 - (382 + 256), 'surplus');
    const nav = navBridge(example, 1000);
    close(nav.equityValue, 1000 + 85 * 0.49 + 42.4 + 218, 'equity value');
    close(nav.perShareValue, nav.equityValue / 958, 'NAV per share');
});

test('runAll covers every scenario, price and rate', () => {
    const results = runAll(example);
    assert.equal(results.cases.length, 4);
    assert.equal(results.cases[0].length, 4);
    assert.equal(results.cases[0][0].npvs.length, 3);
    assert.ok(results.cases[3][3].npvs[0].attributable > results.cases[3][0].npvs[0].attributable, 'higher price gives higher NPV');
});

test('parseNumber reads Italian and English notation', () => {
    assert.equal(parseNumber('1.234,5'), 1234.5);
    assert.equal(parseNumber('1234,5'), 1234.5);
    assert.equal(parseNumber('1,234.5'), 1234.5);
    assert.equal(parseNumber('12 %'), 12);
    assert.equal(parseNumber('abc'), null);
    assert.equal(parseNumber(''), null);
});

test('validateProject flags a project without production', () => {
    const empty = normalizeProject({});
    assert.ok(validateProject(empty).some((issue) => issue.level === 'error'));
    assert.deepEqual(
        validateProject(example).filter((issue) => issue.level === 'error'),
        []
    );
});
