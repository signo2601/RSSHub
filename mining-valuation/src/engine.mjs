// Calculation engine for mining project valuation (pure functions, no DOM).
// Money values share one unit (e.g. M US$), production shares one unit (e.g. Mlb), rates are fractions (0.08 = 8%).

export const SCHEMA_VERSION = 1;

const toNumber = (value) => {
    const number = typeof value === 'number' ? value : Number.parseFloat(value);
    return Number.isFinite(number) ? number : 0;
};

export const sum = (values) => values.reduce((total, value) => total + value, 0);

// Pads / truncates to `length` and coerces anything non-numeric to 0.
const fit = (values, length) => Array.from({ length }, (_, index) => toNumber(values?.[index]));

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export const emptyProject = (startYear = 2028, yearsCount = 20) => ({
    schemaVersion: SCHEMA_VERSION,
    meta: {
        name: 'Nuovo progetto',
        company: '',
        commodity: 'Rame',
        productionUnit: 'kt',
        priceUnit: 'US$/t',
        currency: 'US$',
        moneyUnit: 'M US$',
    },
    years: Array.from({ length: yearsCount }, (_, index) => startYear + index),
    plan: {
        production: Array.from({ length: yearsCount }, () => 0),
        costLines: [
            { name: 'Miniera', variableShare: 0.7, values: Array.from({ length: yearsCount }, () => 0) },
            { name: 'Trattamento', variableShare: 0.85, values: Array.from({ length: yearsCount }, () => 0) },
            { name: 'Sito e G&A', variableShare: 0.25, values: Array.from({ length: yearsCount }, () => 0) },
            { name: 'Vendita e trasporto', variableShare: 1, values: Array.from({ length: yearsCount }, () => 0) },
        ],
        sustainingCapex: { variableShare: 0.8, values: Array.from({ length: yearsCount }, () => 0) },
        closureFund: Array.from({ length: yearsCount }, () => 0),
        workingCapital: Array.from({ length: yearsCount }, () => 0),
        initialCapex: Array.from({ length: yearsCount }, () => 0),
    },
    revenue: {
        prices: [100],
        realizationFactor: 1,
        realizationYears: 0,
        escalation: 0,
        royaltyRate: 0.03,
    },
    scenarios: [{ name: 'Piano base', production: null, additionalCapex: 0, efficiency: 1 }],
    tax: { rate: 0.3, holidayYears: 0, openingPool: 0 },
    capital: {
        remainingCapex: 0,
        companyShare: 1,
        capexShare: 1,
        cash: 0,
        debt: 0,
        debtFacility: 0,
        warrantProceeds: 0,
        includeWarrantProceedsInNav: true,
    },
    discount: { rates: [0.08, 0.1, 0.12], midYear: false, valuationYear: null },
    equity: {
        shares: 100,
        warrants: 0,
        sharePrice: 1,
        fx: 1,
        localCurrency: 'US$',
        peMultiples: [15, 20],
        averageYears: 0,
        referenceYear: null,
        investment: 10000,
    },
    otherAssets: [],
});

// Fills defaults and aligns every annual series to `years`, so imported or hand-edited projects never break the maths.
export function normalizeProject(input) {
    const base = emptyProject();
    const years = (input.years?.length ? input.years : base.years).map((year) => Math.round(toNumber(year)));
    const length = years.length;
    const plan = input.plan ?? {};
    const costLines = (plan.costLines ?? base.plan.costLines).map((line) => ({
        name: String(line.name ?? 'Voce di costo'),
        variableShare: clamp(toNumber(line.variableShare), 0, 1),
        values: fit(line.values, length),
    }));
    const scenarios = (input.scenarios?.length ? input.scenarios : base.scenarios).map((scenario) => ({
        name: String(scenario.name ?? 'Scenario'),
        production: Array.isArray(scenario.production) ? fit(scenario.production, length) : null,
        additionalCapex: toNumber(scenario.additionalCapex),
        efficiency: scenario.efficiency === undefined || scenario.efficiency === null ? 1 : toNumber(scenario.efficiency),
    }));
    return {
        schemaVersion: SCHEMA_VERSION,
        meta: { ...base.meta, ...input.meta },
        years,
        plan: {
            production: fit(plan.production, length),
            costLines,
            sustainingCapex: {
                variableShare: clamp(toNumber(plan.sustainingCapex?.variableShare ?? base.plan.sustainingCapex.variableShare), 0, 1),
                values: fit(plan.sustainingCapex?.values, length),
            },
            closureFund: fit(plan.closureFund, length),
            workingCapital: fit(plan.workingCapital, length),
            initialCapex: fit(plan.initialCapex, length),
        },
        revenue: { ...base.revenue, ...input.revenue, prices: (input.revenue?.prices?.length ? input.revenue.prices : base.revenue.prices).map(toNumber) },
        scenarios,
        tax: { ...base.tax, ...input.tax },
        capital: { ...base.capital, ...input.capital },
        discount: { ...base.discount, ...input.discount, rates: (input.discount?.rates?.length ? input.discount.rates : base.discount.rates).map(toNumber) },
        equity: { ...base.equity, ...input.equity, peMultiples: (input.equity?.peMultiples?.length ? input.equity.peMultiples : base.equity.peMultiples).map(toNumber) },
        otherAssets: (input.otherAssets ?? []).map((asset) => ({ name: String(asset.name ?? 'Asset'), value: toNumber(asset.value), stake: clamp(toNumber(asset.stake ?? 1), 0, 1) })),
    };
}

// Plain-language problems the user should fix before trusting the numbers.
export function validateProject(project) {
    const issues = [];
    const add = (level, message) => issues.push({ level, message });
    if (!project.plan.production.some((value) => value > 0)) {
        add('error', 'Il piano base non ha produzione: inserisci almeno un anno con produzione maggiore di zero.');
    }
    if (project.revenue.prices.length === 0 || project.revenue.prices.some((price) => price <= 0)) {
        add('error', 'Inserisci almeno un prezzo della materia prima maggiore di zero.');
    }
    if (project.equity.shares + project.equity.warrants <= 0) {
        add('warn', 'Le azioni in circolazione sono zero: i valori per azione non possono essere calcolati.');
    }
    if (project.capital.companyShare <= 0 || project.capital.companyShare > 1) {
        add('error', 'La quota della società nel progetto deve essere tra 0% e 100%.');
    }
    if (project.discount.rates.some((rate) => rate <= -1)) {
        add('error', 'Il tasso di sconto non è valido.');
    }
    if (project.revenue.royaltyRate < 0 || project.revenue.royaltyRate >= 1) {
        add('warn', 'La royalty dovrebbe essere una percentuale dei ricavi tra 0% e 100%.');
    }
    for (const scenario of project.scenarios) {
        if (scenario.production && !scenario.production.some((value) => value > 0)) {
            add('warn', `Lo scenario "${scenario.name}" non ha produzione: viene valutato a zero.`);
        }
    }
    return issues;
}

// Variable share of a cost scales with the production delta versus the base plan; the fixed share stays flat.
// `efficiency` (k) lets the extra volume cost less (<1) or more (>1) than the average unit cost.
const scaleWithProduction = (baseValues, baseProduction, production, variableShare, efficiency) =>
    baseValues.map((value, index) => {
        if (!(baseProduction[index] > 0)) {
            return value;
        }
        const delta = production[index] - baseProduction[index];
        return value + ((value * variableShare) / baseProduction[index]) * delta * efficiency;
    });

// Tax on the pre-tax cash flow: no tax during the holiday, an opening pool of deductible losses / allowances is used first,
// later losses are added to the pool.
export function computeTax(preTaxCashFlow, tax) {
    let pool = Math.max(0, toNumber(tax.openingPool));
    const holiday = Math.max(0, Math.round(toNumber(tax.holidayYears)));
    return preTaxCashFlow.map((cashFlow, index) => {
        if (index < holiday) {
            return 0;
        }
        if (cashFlow <= 0) {
            pool -= cashFlow;
            return 0;
        }
        const used = Math.min(pool, cashFlow);
        pool -= used;
        return (cashFlow - used) * toNumber(tax.rate);
    });
}

export function realizedPrices(project, price) {
    const { realizationFactor, realizationYears, escalation } = project.revenue;
    return project.years.map((_, index) => {
        const factor = index < realizationYears ? realizationFactor : 1;
        return price * (1 + escalation) ** index * factor;
    });
}

// One scenario at one commodity price: the full annual table down to attributable cash flow.
export function simulate(project, scenario, price) {
    const { years, plan } = project;
    const length = years.length;
    const production = scenario.production ?? plan.production;
    const efficiency = scenario.efficiency ?? 1;

    let lastProductionIndex = -1;
    production.forEach((value, index) => {
        if (value > 0) {
            lastProductionIndex = index;
        }
    });
    // After the last producing year the mine is closed: no operating costs or capex.
    const alive = (values) => values.map((value, index) => (index <= lastProductionIndex ? value : 0));

    const prices = realizedPrices(project, price);
    const revenue = production.map((volume, index) => volume * prices[index]);
    const costLines = plan.costLines.map((line) => ({
        name: line.name,
        values: alive(scaleWithProduction(line.values, plan.production, production, line.variableShare, efficiency)),
    }));
    const royalty = revenue.map((value) => value * toNumber(project.revenue.royaltyRate));
    const operatingCost = years.map((_, index) => sum(costLines.map((line) => line.values[index])));
    const ebitda = years.map((_, index) => revenue[index] - operatingCost[index] - royalty[index]);
    const initialCapex = alive(plan.initialCapex);
    const sustainingCapex = alive(scaleWithProduction(plan.sustainingCapex.values, plan.production, production, plan.sustainingCapex.variableShare, efficiency));
    const closureFund = alive(plan.closureFund);
    const workingCapital = alive(plan.workingCapital);
    const preTaxCashFlow = years.map((_, index) => ebitda[index] - initialCapex[index] - sustainingCapex[index] - closureFund[index] - workingCapital[index]);
    const tax = computeTax(preTaxCashFlow, project.tax);
    const postTaxCashFlow = preTaxCashFlow.map((value, index) => value - tax[index]);
    // The company owns `companyShare` of the operating cash flow but pays `capexShare` of capex (a carried partner pays none).
    const { companyShare, capexShare } = project.capital;
    const attributableCashFlow = postTaxCashFlow.map((value, index) => companyShare * (value + initialCapex[index]) - capexShare * initialCapex[index]);

    return {
        years,
        price,
        production,
        prices,
        revenue,
        costLines,
        royalty,
        operatingCost,
        ebitda,
        initialCapex,
        sustainingCapex,
        closureFund,
        workingCapital,
        preTaxCashFlow,
        tax,
        postTaxCashFlow,
        attributableCashFlow,
        lifeYears: lastProductionIndex + 1,
        totals: {
            production: sum(production),
            revenue: sum(revenue),
            ebitda: sum(ebitda),
            preTaxCashFlow: sum(preTaxCashFlow),
            tax: sum(tax),
            postTaxCashFlow: sum(postTaxCashFlow),
            attributableCashFlow: sum(attributableCashFlow),
        },
        length,
    };
}

export const discountFactors = (project, rate) => {
    const valuationYear = project.discount.valuationYear ?? project.years[0];
    const shift = project.discount.midYear ? 0.5 : 0;
    return project.years.map((year) => 1 / (1 + rate) ** (year - valuationYear + shift));
};

// NPV at one rate. Remaining capex is a lump sum at the valuation date (not discounted), as in the source model.
export function npv(project, scenario, simulation, rate) {
    const factors = discountFactors(project, rate);
    const presentValue = (series) => sum(series.map((value, index) => value * factors[index]));
    const upfrontCapex = project.capital.remainingCapex + scenario.additionalCapex;
    const project100 = presentValue(simulation.postTaxCashFlow) - upfrontCapex;
    const attributable = presentValue(simulation.attributableCashFlow) - project.capital.capexShare * upfrontCapex;
    return { rate, upfrontCapex, project100, attributable };
}

export const otherAssetsValue = (project) => sum(project.otherAssets.map((asset) => asset.value * asset.stake));

export const fullyDilutedShares = (project) => project.equity.shares + project.equity.warrants;

// Cash-flow-per-share valuation: average and reference-year attributable cash flow, times each P/E multiple.
export function perShare(project, simulation) {
    const { equity } = project;
    const shares = fullyDilutedShares(project);
    const flows = simulation.attributableCashFlow.slice(0, simulation.lifeYears);
    const window = equity.averageYears > 0 ? Math.min(equity.averageYears, flows.length) : flows.length;
    const meanCashFlow = window > 0 ? sum(flows.slice(0, window)) / window : 0;
    const referenceYear = equity.referenceYear ?? project.years[Math.min(1, project.years.length - 1)];
    const referenceIndex = project.years.indexOf(referenceYear);
    const referenceCashFlow = referenceIndex >= 0 ? simulation.attributableCashFlow[referenceIndex] : 0;
    const epsMean = shares > 0 ? meanCashFlow / shares : 0;
    const epsReference = shares > 0 ? referenceCashFlow / shares : 0;
    const price = equity.sharePrice;
    const targets = equity.peMultiples.map((multiple) => {
        const make = (eps) => {
            const target = eps * multiple;
            const multipleOfPrice = price > 0 ? target / price : 0;
            return { target, targetLocal: target * equity.fx, returnMultiple: multipleOfPrice, investmentValue: equity.investment * multipleOfPrice };
        };
        return { multiple, mean: make(epsMean), reference: make(epsReference) };
    });
    return { shares, window, referenceYear, meanCashFlow, referenceCashFlow, epsMean, epsReference, targets };
}

// Net asset value of the equity per share: NPV + other assets + cash - debt (+ warrant proceeds when warrants are in the share count).
export function navBridge(project, attributableNpv) {
    const { capital, equity } = project;
    const other = otherAssetsValue(project);
    const warrantProceeds = capital.includeWarrantProceedsInNav && equity.warrants > 0 ? capital.warrantProceeds : 0;
    const equityValue = attributableNpv + other + capital.cash - capital.debt + warrantProceeds;
    const shares = fullyDilutedShares(project);
    const perShareValue = shares > 0 ? equityValue / shares : 0;
    const marketCap = equity.shares * equity.sharePrice;
    return {
        attributableNpv,
        other,
        cash: capital.cash,
        debt: capital.debt,
        warrantProceeds,
        equityValue,
        perShareValue,
        perShareLocal: perShareValue * equity.fx,
        marketCap,
        priceToNav: equityValue > 0 ? marketCap / equityValue : null,
        upside: equity.sharePrice > 0 ? perShareValue / equity.sharePrice - 1 : null,
    };
}

// Sources versus uses of funds before production (remaining capex and the scenario's extra capex).
export function fundingCheck(project, scenario) {
    const { capital } = project;
    const uses = capital.remainingCapex + scenario.additionalCapex;
    const sources = capital.cash + capital.debtFacility + capital.warrantProceeds;
    return { uses, cash: capital.cash, debtFacility: capital.debtFacility, warrantProceeds: capital.warrantProceeds, sources, surplus: sources - uses };
}

// Every scenario x price x rate. `cases[scenarioIndex][priceIndex]` holds the simulation and its NPVs.
export function runAll(project) {
    const rates = project.discount.rates;
    const cases = project.scenarios.map((scenario) =>
        project.revenue.prices.map((price) => {
            const simulation = simulate(project, scenario, price);
            const npvs = rates.map((rate) => npv(project, scenario, simulation, rate));
            return { scenario, price, simulation, npvs, perShare: perShare(project, simulation) };
        })
    );
    return { project, rates, prices: project.revenue.prices, scenarios: project.scenarios, cases, otherAssets: otherAssetsValue(project) };
}

// Expansion capex by the power-law rule: cost scales with (new capacity / old capacity) ^ exponent after escalation.
export function estimateExpansionCapex({ items, capacityRatio, escalation, years }) {
    const rows = items.map((item) => {
        const escalated = toNumber(item.baseCost) * (1 + escalation) ** years;
        const scaled = escalated * capacityRatio ** toNumber(item.exponent);
        return { name: item.name, escalated, scaled, delta: scaled - escalated };
    });
    return { rows, total: sum(rows.map((row) => row.delta)) };
}

// Parses numbers typed or pasted in Italian or English notation: "1.234,5", "1234,5", "1,234.5", "12%".
export function parseNumber(text) {
    if (typeof text === 'number') {
        return Number.isFinite(text) ? text : null;
    }
    let value = String(text ?? '')
        .trim()
        .replaceAll(/[\s %]/g, '');
    if (value === '' || value === '-') {
        return null;
    }
    const lastComma = value.lastIndexOf(',');
    const lastDot = value.lastIndexOf('.');
    if (lastComma !== -1 && lastDot !== -1) {
        value = lastComma > lastDot ? value.replaceAll('.', '').replace(',', '.') : value.replaceAll(',', '');
    } else if (lastComma !== -1) {
        value = value.replace(',', '.');
    }
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}
