/* global EXAMPLE_PROJECT */
import { discountFactors, emptyProject, estimateExpansionCapex, fundingCheck, navBridge, normalizeProject, parseNumber, runAll, sum, validateProject } from './engine.mjs';

// Set to false by the build for hosts that block file downloads (copy buttons still work).
const CAN_DOWNLOAD = true;
const STORAGE_KEY = 'mining-valuation-project-v1';
const MAX_YEARS = 60;
const TABS = [
    { id: 'progetto', label: 'Progetto' },
    { id: 'piano', label: 'Piano annuale' },
    { id: 'scenari', label: 'Scenari' },
    { id: 'capitale', label: 'Tasse e capitale' },
    { id: 'azioni', label: 'Azioni e multipli' },
];

let project;
let results;
const ui = { tab: 'progetto', view: 'dati', scenario: 0, price: 0, rate: 0, basis: 'attributable', estimatorOpen: false };
const estimator = {
    currentCapacity: 1200,
    newCapacity: 2000,
    escalation: 0.05,
    years: 3,
    items: [
        { name: 'Costo impianto', baseCost: 96, exponent: 0.6 },
        { name: 'Costi del proprietario', baseCost: 66.9, exponent: 0.3 },
        { name: 'EPCM', baseCost: 17.4, exponent: 0.8 },
        { name: 'Miniera', baseCost: 98.3, exponent: 0.9 },
        { name: 'Ricambi', baseCost: 2.2, exponent: 0.6 },
        { name: 'Studi e progetti', baseCost: 3.2, exponent: 0.65 },
        { name: 'Mezzi mobili di superficie', baseCost: 5.7, exponent: 0.65 },
        { name: 'Infrastrutture', baseCost: 80.4, exponent: 0.64 },
    ],
    target: 0,
};

// ---------- small DOM and formatting helpers ----------

const appendChildren = (element, children) => {
    for (const child of children.flat(Infinity)) {
        if (child === null || child === undefined || child === false) {
            continue;
        }
        element.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
};

const h = (tag, attributes = {}, ...children) => {
    const element = document.createElement(tag);
    for (const [name, value] of Object.entries(attributes)) {
        if (value === undefined || value === null || value === false) {
            continue;
        }
        if (name === 'class') {
            element.className = value;
        } else if (name === 'text') {
            element.textContent = value;
        } else if (name === 'value') {
            element.value = value;
        } else if (name.startsWith('on')) {
            element.addEventListener(name.slice(2), value);
        } else {
            element.setAttribute(name, value === true ? '' : value);
        }
    }
    appendChildren(element, children);
    return element;
};

const SVG_NS = 'http://www.w3.org/2000/svg';
const s = (tag, attributes = {}, ...children) => {
    const element = document.createElementNS(SVG_NS, tag);
    for (const [name, value] of Object.entries(attributes)) {
        if (value !== undefined && value !== null) {
            element.setAttribute(name, value);
        }
    }
    appendChildren(element, children);
    return element;
};

const formatters = new Map();
const fmt = (value, digits = 0) => {
    if (value === null || value === undefined || !Number.isFinite(value)) {
        return '–';
    }
    if (!formatters.has(digits)) {
        formatters.set(digits, new Intl.NumberFormat('it-IT', { minimumFractionDigits: digits, maximumFractionDigits: digits }));
    }
    const text = formatters.get(digits).format(value);
    return text === '-0' ? '0' : text;
};
const fmtPct = (value, digits = 0) => (value === null || value === undefined || !Number.isFinite(value) ? '–' : `${fmt(value * 100, digits)}%`);
const fmtSigned = (value, digits = 0) => (Number.isFinite(value) ? `${value > 0 ? '+' : ''}${fmt(value, digits)}` : '–');
const fmtInput = (value) => (Number.isFinite(value) ? String(Math.round(value * 1e6) / 1e6).replace('.', ',') : '');
const fmtPctInput = (value) => (Number.isFinite(value) ? String(Math.round(value * 1e8) / 1e6).replace('.', ',') : '');
const parseList = (text) =>
    String(text)
        .split(/[\s;]+/)
        .map((part) => parseNumber(part))
        .filter((value) => value !== null);
const clampInt = (value, min, max) => Math.min(max, Math.max(min, Math.round(value)));

// ---------- state ----------

let saveTimer;
const saveLater = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(project));
        } catch {
            // Storage can be blocked (private window, previews); the app works without it.
        }
    }, 400);
};

const clampSelection = () => {
    ui.scenario = Math.min(ui.scenario, project.scenarios.length - 1);
    ui.price = Math.min(ui.price, project.revenue.prices.length - 1);
    ui.rate = Math.min(ui.rate, project.discount.rates.length - 1);
};

const recalc = () => {
    clampSelection();
    results = runAll(project);
    renderResults();
    saveLater();
};

const setProject = (next) => {
    project = normalizeProject(next);
    ui.scenario = 0;
    ui.price = 0;
    ui.rate = 0;
    renderForm();
    recalc();
};

const resizeYears = (startYear, count) => {
    const length = clampInt(count, 1, MAX_YEARS);
    const fit = (values) => Array.from({ length }, (_, index) => values?.[index] ?? 0);
    project.years = Array.from({ length }, (_, index) => startYear + index);
    const { plan } = project;
    plan.production = fit(plan.production);
    for (const line of plan.costLines) {
        line.values = fit(line.values);
    }
    plan.sustainingCapex.values = fit(plan.sustainingCapex.values);
    plan.closureFund = fit(plan.closureFund);
    plan.workingCapital = fit(plan.workingCapital);
    plan.initialCapex = fit(plan.initialCapex);
    for (const scenario of project.scenarios) {
        if (scenario.production) {
            scenario.production = fit(scenario.production);
        }
    }
};

// ---------- form fields ----------

const scalarField = ({ label, hint, get, set, kind = 'number', suffix, wide }) => {
    const toDisplay = () => {
        const value = get();
        if (kind === 'text') {
            return value ?? '';
        }
        if (kind === 'list') {
            return value.map(fmtInput).join(' ');
        }
        if (kind === 'percentList') {
            return value.map(fmtPctInput).join(' ');
        }
        return kind === 'percent' ? fmtPctInput(value) : fmtInput(value);
    };
    const input = h('input', { type: 'text', inputmode: kind === 'text' ? 'text' : 'decimal', value: toDisplay(), autocomplete: 'off', spellcheck: 'false' });
    input.addEventListener('change', () => {
        if (kind === 'text') {
            set(input.value.trim());
        } else if (kind === 'list' || kind === 'percentList') {
            const values = parseList(input.value);
            if (values.length > 0) {
                set(kind === 'percentList' ? values.map((value) => value / 100) : values);
            }
        } else {
            const number = parseNumber(input.value);
            if (number !== null) {
                set(kind === 'percent' ? number / 100 : number);
            }
        }
        input.value = toDisplay();
        recalc();
    });
    input.addEventListener('focus', () => input.select());
    return h(
        'label',
        { class: `field${wide ? ' field-wide' : ''}` },
        h('span', { class: 'field-label', text: label }),
        h('span', { class: 'field-control' }, input, suffix ? h('span', { class: 'field-suffix', text: suffix }) : null),
        hint ? h('span', { class: 'field-hint', text: hint }) : null
    );
};

const checkField = ({ label, hint, get, set }) => {
    const input = h('input', { type: 'checkbox' });
    input.checked = Boolean(get());
    input.addEventListener('change', () => {
        set(input.checked);
        recalc();
    });
    return h('label', { class: 'check' }, input, h('span', {}, h('span', { class: 'field-label', text: label }), hint ? h('span', { class: 'field-hint', text: hint }) : null));
};

const card = (title, description, ...children) => h('section', { class: 'card' }, h('header', { class: 'card-head' }, h('h3', { text: title }), description ? h('p', { text: description }) : null), ...children);

const fieldGrid = (...children) => h('div', { class: 'field-grid' }, ...children);

// ---------- editable table (years down, series across) with paste from Excel ----------

const buildGrid = ({ columns, footer = true }) => {
    const rowCount = project.years.length;
    const inputs = [];
    const footerCells = [];

    const refresh = () => {
        for (const entry of inputs) {
            entry.input.value = fmtInput(columns[entry.col].get(entry.row));
        }
        columns.forEach((column, index) => {
            if (footerCells[index]) {
                footerCells[index].textContent = fmt(sum(project.years.map((_, row) => column.get(row))), 2);
            }
        });
    };

    const applyPaste = (text, startRow, startCol) => {
        let matrix = text
            .trim()
            .split(/\r?\n/)
            .map((line) => line.split('\t'));
        // One pasted row (years across in Excel) is laid out down the column.
        if (matrix.length === 1 && matrix[0].length > 1) {
            matrix = matrix[0].map((cell) => [cell]);
        }
        matrix.forEach((cells, rowOffset) => {
            cells.forEach((cell, colOffset) => {
                const row = startRow + rowOffset;
                const col = startCol + colOffset;
                const value = parseNumber(cell);
                if (value !== null && row < rowCount && col < columns.length) {
                    columns[col].set(row, value);
                }
            });
        });
        refresh();
        recalc();
    };

    const head = h(
        'tr',
        {},
        h('th', { class: 'sticky-col', text: 'Anno' }),
        columns.map((column) => h('th', {}, h('span', { class: 'th-title', text: column.header }), column.sub ?? null))
    );
    const body = project.years.map((year, row) =>
        h(
            'tr',
            {},
            h('th', { class: 'sticky-col year', scope: 'row', text: String(year) }),
            columns.map((column, col) => {
                const input = h('input', { type: 'text', inputmode: 'decimal', value: fmtInput(column.get(row)), 'aria-label': `${column.header} ${year}`, autocomplete: 'off' });
                input.addEventListener('change', () => {
                    const value = parseNumber(input.value);
                    if (value !== null) {
                        column.set(row, value);
                    }
                    refresh();
                    recalc();
                });
                input.addEventListener('focus', () => input.select());
                input.addEventListener('paste', (event) => {
                    const text = event.clipboardData?.getData('text') ?? '';
                    if (/[\t\n]/.test(text.trim())) {
                        event.preventDefault();
                        applyPaste(text, row, col);
                    }
                });
                input.addEventListener('keydown', (event) => {
                    const move = { Enter: 1, ArrowDown: 1, ArrowUp: -1 }[event.key];
                    if (move) {
                        event.preventDefault();
                        input.dispatchEvent(new Event('change'));
                        inputs.find((entry) => entry.row === row + move && entry.col === col)?.input.focus();
                    }
                });
                inputs.push({ input, row, col });
                return h('td', {}, input);
            })
        )
    );
    const foot = footer
        ? h(
              'tr',
              { class: 'grid-total' },
              h('th', { class: 'sticky-col', text: 'Totale' }),
              columns.map((_, index) => {
                  const cell = h('td', {});
                  footerCells[index] = cell;
                  return cell;
              })
          )
        : null;
    const table = h('table', { class: 'grid' }, h('thead', {}, head), h('tbody', {}, body), foot ? h('tfoot', {}, foot) : null);
    refresh();
    return h('div', { class: 'table-scroll' }, table);
};

const compactInput = ({ get, set, kind = 'percent', label }) => {
    const input = h('input', { type: 'text', inputmode: 'decimal', value: kind === 'percent' ? fmtPctInput(get()) : fmtInput(get()), 'aria-label': label, autocomplete: 'off' });
    input.addEventListener('change', () => {
        const number = parseNumber(input.value);
        if (number !== null) {
            set(kind === 'percent' ? Math.min(1, Math.max(0, number / 100)) : number);
        }
        input.value = kind === 'percent' ? fmtPctInput(get()) : fmtInput(get());
        recalc();
    });
    input.addEventListener('focus', () => input.select());
    return h('span', { class: 'th-sub' }, h('span', { text: 'quota variabile' }), h('span', { class: 'field-control mini' }, input, h('span', { class: 'field-suffix', text: '%' })));
};

// ---------- tabs ----------

const tabProject = () => {
    const { meta, revenue, capital, discount } = project;
    return h(
        'div',
        { class: 'stack' },
        card(
            'Progetto',
            'Nomi e unità servono solo per le etichette dei risultati.',
            fieldGrid(
                scalarField({ label: 'Nome del progetto', kind: 'text', get: () => meta.name, set: (v) => (meta.name = v), wide: true }),
                scalarField({ label: 'Società', kind: 'text', get: () => meta.company, set: (v) => (meta.company = v) }),
                scalarField({ label: 'Materia prima', kind: 'text', get: () => meta.commodity, set: (v) => (meta.commodity = v) }),
                scalarField({ label: 'Unità di produzione', kind: 'text', get: () => meta.productionUnit, set: (v) => (meta.productionUnit = v), hint: 'es. Mlb, kt, koz' }),
                scalarField({ label: 'Unità di prezzo', kind: 'text', get: () => meta.priceUnit, set: (v) => (meta.priceUnit = v), hint: 'es. US$/lb, US$/t, US$/oz' }),
                scalarField({ label: 'Valuta', kind: 'text', get: () => meta.currency, set: (v) => (meta.currency = v) }),
                scalarField({ label: 'Unità dei valori monetari', kind: 'text', get: () => meta.moneyUnit, set: (v) => (meta.moneyUnit = v), hint: 'es. M US$ = milioni' })
            )
        ),
        card(
            'Durata e partecipazione',
            null,
            fieldGrid(
                scalarField({
                    label: 'Primo anno del piano',
                    kind: 'number',
                    get: () => project.years[0],
                    set: (v) => resizeYears(Math.round(v), project.years.length),
                }),
                scalarField({
                    label: 'Anni nel piano',
                    kind: 'number',
                    get: () => project.years.length,
                    set: (v) => {
                        resizeYears(project.years[0], v);
                        renderForm();
                    },
                    hint: `Massimo ${MAX_YEARS}. I dati già inseriti restano.`,
                }),
                scalarField({
                    label: 'Quota della società nei flussi',
                    kind: 'percent',
                    suffix: '%',
                    get: () => capital.companyShare,
                    set: (v) => (capital.companyShare = Math.min(1, Math.max(0, v))),
                    hint: 'Parte dei flussi di cassa del progetto che spetta alla società (es. 80% se lo Stato ha il 20%).',
                }),
                scalarField({
                    label: 'Quota del capex a carico della società',
                    kind: 'percent',
                    suffix: '%',
                    get: () => capital.capexShare,
                    set: (v) => (capital.capexShare = Math.min(1, Math.max(0, v))),
                    hint: '100% se il socio di minoranza non paga (partecipazione «carried»).',
                })
            )
        ),
        card(
            'Prezzi e ricavi',
            null,
            fieldGrid(
                scalarField({
                    label: 'Prezzi da simulare',
                    kind: 'list',
                    get: () => revenue.prices,
                    set: (v) => (revenue.prices = v.slice(0, 8)),
                    suffix: meta.priceUnit,
                    hint: 'Separati da spazio, fino a 8 (es. 110 130 150 170). Ogni prezzo è una colonna dei risultati.',
                    wide: true,
                }),
                scalarField({
                    label: 'Realizzo sui primi anni',
                    kind: 'percent',
                    suffix: '%',
                    get: () => revenue.realizationFactor,
                    set: (v) => (revenue.realizationFactor = Math.max(0, v)),
                    hint: 'Quota del prezzo di mercato incassata sui volumi già venduti con contratti (es. 90%).',
                }),
                scalarField({
                    label: 'Anni con realizzo ridotto',
                    kind: 'number',
                    get: () => revenue.realizationYears,
                    set: (v) => (revenue.realizationYears = clampInt(v, 0, MAX_YEARS)),
                    hint: 'Contati dal primo anno del piano. 0 = nessuno sconto.',
                }),
                scalarField({
                    label: 'Crescita annua del prezzo',
                    kind: 'percent',
                    suffix: '%',
                    get: () => revenue.escalation,
                    set: (v) => (revenue.escalation = v),
                    hint: '0% = prezzo costante.',
                }),
                scalarField({
                    label: 'Royalty sui ricavi',
                    kind: 'percent',
                    suffix: '%',
                    get: () => revenue.royaltyRate,
                    set: (v) => (revenue.royaltyRate = Math.max(0, v)),
                })
            )
        ),
        card(
            'Sconto e capex iniziale',
            null,
            fieldGrid(
                scalarField({
                    label: 'Capex residuo prima della produzione',
                    kind: 'number',
                    suffix: meta.moneyUnit,
                    get: () => capital.remainingCapex,
                    set: (v) => (capital.remainingCapex = Math.max(0, v)),
                    hint: 'Speso alla data di valutazione, non scontato.',
                }),
                scalarField({
                    label: 'Tassi di sconto',
                    kind: 'percentList',
                    suffix: '%',
                    get: () => discount.rates,
                    set: (v) => (discount.rates = v.slice(0, 6)),
                    hint: 'Separati da spazio, fino a 6 (es. 8 10 12).',
                }),
                scalarField({
                    label: 'Anno di valutazione',
                    kind: 'number',
                    get: () => discount.valuationYear ?? project.years[0],
                    set: (v) => (discount.valuationYear = Math.round(v) === project.years[0] ? null : Math.round(v)),
                    hint: 'I flussi di quest’anno non vengono scontati.',
                }),
                checkField({
                    label: 'Flussi a metà anno',
                    hint: 'Sconta i flussi come se arrivassero a metà anno (+0,5 anni).',
                    get: () => discount.midYear,
                    set: (v) => (discount.midYear = v),
                })
            )
        )
    );
};

const tabPlan = () => {
    const { plan, meta } = project;
    const columns = [
        { header: `Produzione (${meta.productionUnit})`, get: (r) => plan.production[r], set: (r, v) => (plan.production[r] = v) },
        ...plan.costLines.map((line) => ({
            header: line.name,
            sub: compactInput({ label: `Quota variabile ${line.name}`, get: () => line.variableShare, set: (v) => (line.variableShare = v) }),
            get: (r) => line.values[r],
            set: (r, v) => (line.values[r] = v),
        })),
        {
            header: 'Capex di sostenimento',
            sub: compactInput({ label: 'Quota variabile capex di sostenimento', get: () => plan.sustainingCapex.variableShare, set: (v) => (plan.sustainingCapex.variableShare = v) }),
            get: (r) => plan.sustainingCapex.values[r],
            set: (r, v) => (plan.sustainingCapex.values[r] = v),
        },
        { header: 'Fondo di chiusura', get: (r) => plan.closureFund[r], set: (r, v) => (plan.closureFund[r] = v) },
        { header: 'Capitale circolante (aumento = +)', get: (r) => plan.workingCapital[r], set: (r, v) => (plan.workingCapital[r] = v) },
        { header: 'Capex di sviluppo negli anni', get: (r) => plan.initialCapex[r], set: (r, v) => (plan.initialCapex[r] = v) },
    ];
    return h(
        'div',
        { class: 'stack' },
        card(
            'Piano base (studio di fattibilità)',
            `Una riga per anno. Valori monetari in ${meta.moneyUnit}. Puoi incollare un blocco copiato da Excel: parte dalla cella selezionata; una riga di anni in orizzontale viene messa in verticale.`,
            buildGrid({ columns })
        ),
        card(
            'Voci di costo operativo',
            'La «quota variabile» dice quanto del costo cresce con la produzione quando uno scenario produce più (o meno) del piano base. La parte fissa non cambia.',
            h(
                'div',
                { class: 'chip-row' },
                project.plan.costLines.map((line, index) =>
                    h(
                        'span',
                        { class: 'chip' },
                        h('input', {
                            type: 'text',
                            value: line.name,
                            'aria-label': 'Nome voce di costo',
                            onchange: (event) => {
                                line.name = event.target.value.trim() || line.name;
                                renderForm();
                                recalc();
                            },
                        }),
                        project.plan.costLines.length > 1
                            ? h('button', {
                                  type: 'button',
                                  class: 'icon-btn',
                                  'aria-label': `Elimina ${line.name}`,
                                  text: '×',
                                  onclick: () => {
                                      project.plan.costLines.splice(index, 1);
                                      renderForm();
                                      recalc();
                                  },
                              })
                            : null
                    )
                ),
                h('button', {
                    type: 'button',
                    class: 'btn ghost small',
                    text: '+ Aggiungi voce',
                    onclick: () => {
                        project.plan.costLines.push({ name: `Voce ${project.plan.costLines.length + 1}`, variableShare: 0.5, values: project.years.map(() => 0) });
                        renderForm();
                        recalc();
                    },
                })
            )
        )
    );
};

const estimatorCard = () => {
    const ratio = estimator.currentCapacity > 0 ? estimator.newCapacity / estimator.currentCapacity : 1;
    const outcome = estimateExpansionCapex({ items: estimator.items, capacityRatio: ratio, escalation: estimator.escalation, years: estimator.years });
    const numeric = (label, get, set, kind = 'number', suffix) => scalarField({ label, kind, get, set: (v) => set(v), suffix });
    const itemsTable = h(
        'table',
        { class: 'mini-table' },
        h('thead', {}, h('tr', {}, h('th', { text: 'Voce' }), h('th', { text: 'Costo base' }), h('th', { text: 'Esponente' }), h('th', { text: 'Aumento' }), h('th'))),
        h(
            'tbody',
            {},
            estimator.items.map((item, index) => {
                const cell = (key, kind) => {
                    const input = h('input', { type: 'text', inputmode: kind === 'text' ? 'text' : 'decimal', value: kind === 'text' ? item[key] : fmtInput(item[key]), 'aria-label': `${item.name} ${key}` });
                    input.addEventListener('change', () => {
                        if (kind === 'text') {
                            item[key] = input.value.trim() || item[key];
                        } else {
                            const number = parseNumber(input.value);
                            if (number !== null) {
                                item[key] = number;
                            }
                        }
                        renderForm();
                    });
                    return h('td', {}, input);
                };
                return h(
                    'tr',
                    {},
                    cell('name', 'text'),
                    cell('baseCost', 'number'),
                    cell('exponent', 'number'),
                    h('td', { class: 'num', text: fmt(outcome.rows[index].delta, 1) }),
                    h(
                        'td',
                        {},
                        h('button', {
                            type: 'button',
                            class: 'icon-btn',
                            text: '×',
                            'aria-label': `Elimina ${item.name}`,
                            onclick: () => {
                                estimator.items.splice(index, 1);
                                renderForm();
                            },
                        })
                    )
                );
            })
        )
    );
    const targetSelect = h(
        'select',
        { 'aria-label': 'Scenario a cui applicare il capex', onchange: (event) => (estimator.target = Number(event.target.value)) },
        project.scenarios.map((scenario, index) => h('option', { value: index, selected: index === estimator.target, text: scenario.name }))
    );
    return h(
        'details',
        { class: 'card details', open: ui.estimatorOpen, ontoggle: (event) => (ui.estimatorOpen = event.target.open) },
        h('summary', {}, h('span', { class: 'summary-title', text: 'Calcolatore del capex di espansione' }), h('span', { class: 'summary-hint', text: 'costo × (capacità nuova / attuale) ^ esponente' })),
        h(
            'div',
            { class: 'stack' },
            h('p', { class: 'muted', text: 'Stima di quanto costa in più ampliare l’impianto. Ogni voce cresce con la capacità elevata a un esponente (0,6 è la regola classica degli impianti).' }),
            fieldGrid(
                numeric(
                    'Capacità attuale',
                    () => estimator.currentCapacity,
                    (v) => ((estimator.currentCapacity = v), renderForm()),
                    'number',
                    'es. tpd'
                ),
                numeric(
                    'Capacità nuova',
                    () => estimator.newCapacity,
                    (v) => ((estimator.newCapacity = v), renderForm()),
                    'number',
                    'es. tpd'
                ),
                numeric(
                    'Inflazione dei costi',
                    () => estimator.escalation,
                    (v) => ((estimator.escalation = v), renderForm()),
                    'percent',
                    '% annuo'
                ),
                numeric(
                    'Anni di inflazione',
                    () => estimator.years,
                    (v) => ((estimator.years = v), renderForm())
                )
            ),
            h('div', { class: 'table-scroll' }, itemsTable),
            h(
                'div',
                { class: 'estimator-foot' },
                h('button', {
                    type: 'button',
                    class: 'btn ghost small',
                    text: '+ Aggiungi voce',
                    onclick: () => {
                        estimator.items.push({ name: 'Nuova voce', baseCost: 0, exponent: 0.6 });
                        renderForm();
                    },
                }),
                h('strong', { class: 'estimator-total', text: `Capex aggiuntivo stimato: ${fmt(outcome.total, 1)} ${project.meta.moneyUnit}` }),
                h(
                    'span',
                    { class: 'apply' },
                    targetSelect,
                    h('button', {
                        type: 'button',
                        class: 'btn small',
                        text: 'Applica',
                        onclick: () => {
                            project.scenarios[Math.min(estimator.target, project.scenarios.length - 1)].additionalCapex = Math.round(outcome.total * 10) / 10;
                            renderForm();
                            recalc();
                        },
                    })
                )
            )
        )
    );
};

const tabScenarios = () => {
    const { scenarios, plan, meta } = project;
    const custom = scenarios.map((scenario, index) => ({ scenario, index })).filter((entry) => entry.scenario.production);
    const scenarioCards = scenarios.map((scenario, index) =>
        h(
            'div',
            { class: 'scenario' },
            h(
                'div',
                { class: 'scenario-head' },
                h('input', {
                    type: 'text',
                    class: 'scenario-name',
                    value: scenario.name,
                    'aria-label': 'Nome scenario',
                    onchange: (event) => {
                        scenario.name = event.target.value.trim() || scenario.name;
                        renderForm();
                        recalc();
                    },
                }),
                scenarios.length > 1
                    ? h('button', {
                          type: 'button',
                          class: 'btn ghost small',
                          text: 'Elimina',
                          onclick: () => {
                              scenarios.splice(index, 1);
                              renderForm();
                              recalc();
                          },
                      })
                    : null
            ),
            fieldGrid(
                scalarField({
                    label: 'Capex aggiuntivo',
                    kind: 'number',
                    suffix: meta.moneyUnit,
                    get: () => scenario.additionalCapex,
                    set: (v) => (scenario.additionalCapex = v),
                    hint: 'Si somma al capex residuo, prima della produzione.',
                }),
                scalarField({
                    label: 'Efficienza sui volumi extra (k)',
                    kind: 'number',
                    get: () => scenario.efficiency,
                    set: (v) => (scenario.efficiency = Math.max(0, v)),
                    hint: '1 = costano come la media; 0,94 = costano il 6% in meno.',
                })
            ),
            checkField({
                label: 'Usa la produzione del piano base',
                hint: 'Togli la spunta per inserire una produzione diversa per questo scenario.',
                get: () => scenario.production === null,
                set: (v) => {
                    scenario.production = v ? null : [...plan.production];
                    renderForm();
                },
            })
        )
    );
    const productionCard = custom.length
        ? card(
              'Produzione per scenario',
              `Produzione annuale in ${meta.productionUnit}. Dopo l’ultimo anno con produzione la miniera è considerata chiusa: niente più costi né capex.`,
              buildGrid({
                  columns: custom.map(({ scenario }) => ({ header: scenario.name, get: (r) => scenario.production[r], set: (r, v) => (scenario.production[r] = v) })),
              })
          )
        : null;
    return h(
        'div',
        { class: 'stack' },
        card(
            'Scenari di capacità',
            'Ogni scenario è una riga dei risultati (es. ampliamento dell’impianto). Il primo di solito è il piano base.',
            h('div', { class: 'scenario-list' }, scenarioCards),
            h('button', {
                type: 'button',
                class: 'btn small',
                text: '+ Aggiungi scenario',
                onclick: () => {
                    const last = scenarios.at(-1);
                    scenarios.push({ name: `Scenario ${scenarios.length + 1}`, production: last.production ? [...last.production] : [...plan.production], additionalCapex: last.additionalCapex, efficiency: last.efficiency });
                    renderForm();
                    recalc();
                },
            })
        ),
        productionCard,
        estimatorCard()
    );
};

const tabCapital = () => {
    const { tax, capital, meta } = project;
    const money = { kind: 'number', suffix: meta.moneyUnit };
    return h(
        'div',
        { class: 'stack' },
        card(
            'Tasse',
            'Le tasse si calcolano sul flusso di cassa ante imposte, come nel modello originale.',
            fieldGrid(
                scalarField({ label: 'Aliquota', kind: 'percent', suffix: '%', get: () => tax.rate, set: (v) => (tax.rate = Math.max(0, v)) }),
                scalarField({
                    label: 'Anni di esenzione',
                    kind: 'number',
                    get: () => tax.holidayYears,
                    set: (v) => (tax.holidayYears = clampInt(v, 0, MAX_YEARS)),
                    hint: 'Primi anni del piano senza imposte.',
                }),
                scalarField({
                    label: 'Deduzioni iniziali (perdite pregresse)',
                    ...money,
                    get: () => tax.openingPool,
                    set: (v) => (tax.openingPool = Math.max(0, v)),
                    hint: 'Importo che riduce l’imponibile finché non è esaurito. Le eventuali perdite future si aggiungono.',
                })
            )
        ),
        card(
            'Finanziamento prima della produzione',
            'Confronta quanto serve (capex residuo + capex dello scenario) con le fonti disponibili. Cassa e debito entrano anche nel NAV per azione.',
            fieldGrid(
                scalarField({ label: 'Cassa disponibile', ...money, get: () => capital.cash, set: (v) => (capital.cash = v) }),
                scalarField({ label: 'Debito già utilizzato', ...money, get: () => capital.debt, set: (v) => (capital.debt = Math.max(0, v)), hint: 'Si sottrae dal NAV.' }),
                scalarField({ label: 'Linea di credito disponibile', ...money, get: () => capital.debtFacility, set: (v) => (capital.debtFacility = Math.max(0, v)), hint: 'Solo per il controllo del finanziamento.' }),
                scalarField({ label: 'Incasso possibile dall’esercizio dei warrant', ...money, get: () => capital.warrantProceeds, set: (v) => (capital.warrantProceeds = Math.max(0, v)) })
            )
        )
    );
};

const assetRows = () => {
    const rows = project.otherAssets.map((asset, index) =>
        h(
            'div',
            { class: 'asset' },
            scalarField({ label: 'Nome', kind: 'text', get: () => asset.name, set: (v) => (asset.name = v), wide: true }),
            scalarField({ label: `Valore al 100% (${project.meta.moneyUnit})`, kind: 'number', get: () => asset.value, set: (v) => (asset.value = v) }),
            scalarField({ label: 'Quota detenuta', kind: 'percent', suffix: '%', get: () => asset.stake, set: (v) => (asset.stake = Math.min(1, Math.max(0, v))) }),
            h('button', {
                type: 'button',
                class: 'btn ghost small',
                text: 'Elimina',
                onclick: () => {
                    project.otherAssets.splice(index, 1);
                    renderForm();
                    recalc();
                },
            })
        )
    );
    return rows;
};

const tabShares = () => {
    const { equity, capital, meta } = project;
    return h(
        'div',
        { class: 'stack' },
        card(
            'Azioni e prezzo',
            null,
            fieldGrid(
                scalarField({ label: 'Azioni in circolazione', kind: 'number', suffix: 'milioni', get: () => equity.shares, set: (v) => (equity.shares = Math.max(0, v)) }),
                scalarField({ label: 'Warrant e opzioni', kind: 'number', suffix: 'milioni', get: () => equity.warrants, set: (v) => (equity.warrants = Math.max(0, v)), hint: 'Contati come azioni nuove (diluizione piena).' }),
                scalarField({ label: `Prezzo attuale dell’azione (${meta.currency})`, kind: 'number', get: () => equity.sharePrice, set: (v) => (equity.sharePrice = Math.max(0, v)) }),
                scalarField({ label: 'Valuta di quotazione', kind: 'text', get: () => equity.localCurrency, set: (v) => (equity.localCurrency = v), hint: 'es. C$, €, A$' }),
                scalarField({ label: `Cambio (1 ${meta.currency} = … quotazione)`, kind: 'number', get: () => equity.fx, set: (v) => (equity.fx = v > 0 ? v : 1), hint: 'Converte i target nella valuta di quotazione.' }),
                checkField({
                    label: 'Aggiungi gli incassi dei warrant al NAV',
                    hint: 'Coerente con il conteggio dei warrant nelle azioni diluite.',
                    get: () => capital.includeWarrantProceedsInNav,
                    set: (v) => (capital.includeWarrantProceedsInNav = v),
                })
            )
        ),
        card(
            'Prezzo obiettivo sugli utili per azione',
            'Come nel modello: flusso di cassa post tasse della società ÷ azioni diluite, moltiplicato per un P/E.',
            fieldGrid(
                scalarField({ label: 'Multipli P/E', kind: 'list', get: () => equity.peMultiples, set: (v) => (equity.peMultiples = v.slice(0, 4)), hint: 'Separati da spazio (es. 20 15).' }),
                scalarField({ label: 'Anni per l’EPS medio', kind: 'number', get: () => equity.averageYears, set: (v) => (equity.averageYears = clampInt(v, 0, MAX_YEARS)), hint: '0 = tutta la vita della miniera.' }),
                scalarField({
                    label: 'Anno di riferimento dell’EPS',
                    kind: 'number',
                    get: () => equity.referenceYear ?? project.years[1] ?? project.years[0],
                    set: (v) => (equity.referenceYear = Math.round(v)),
                }),
                scalarField({
                    label: `Importo investito (${equity.localCurrency || meta.currency})`,
                    kind: 'number',
                    get: () => equity.investment,
                    set: (v) => (equity.investment = Math.max(0, v)),
                    hint: 'Per il calcolo del controvalore.',
                })
            )
        ),
        card(
            'Altri asset e partecipazioni (JV)',
            'Valore di partecipazioni fuori dal progetto (es. una JV). Si somma all’NPV nella colonna «+ altri asset» e nel NAV.',
            h('div', { class: 'asset-list' }, assetRows()),
            h('button', {
                type: 'button',
                class: 'btn small',
                text: '+ Aggiungi asset',
                onclick: () => {
                    project.otherAssets.push({ name: 'Nuova partecipazione', value: 0, stake: 1 });
                    renderForm();
                },
            })
        )
    );
};

const tabBuilders = { progetto: tabProject, piano: tabPlan, scenari: tabScenarios, capitale: tabCapital, azioni: tabShares };

// ---------- charts ----------

const niceScale = (min, max, target = 5) => {
    const lo = Math.min(min, 0);
    const hi = Math.max(max, 0);
    const span = hi - lo || 1;
    const rough = span / target;
    const magnitude = 10 ** Math.floor(Math.log10(rough));
    const step = [1, 2, 2.5, 5, 10].map((factor) => factor * magnitude).find((candidate) => candidate >= rough) ?? 10 * magnitude;
    const start = Math.floor(lo / step) * step;
    const end = Math.ceil(hi / step) * step === start ? start + step : Math.ceil(hi / step) * step;
    const ticks = [];
    for (let value = start; value <= end + step / 2; value += step) {
        ticks.push(Math.abs(value) < step / 1e6 ? 0 : value);
    }
    return { min: start, max: end, ticks };
};

const tooltip = h('div', { class: 'tooltip', role: 'tooltip', hidden: true });
const showTooltip = (event, lines) => {
    tooltip.replaceChildren(...lines.map((line) => h('div', { class: 'tip-row' }, line)));
    tooltip.hidden = false;
    const margin = 12;
    const box = tooltip.getBoundingClientRect();
    const x = Math.min(event.clientX + margin, window.innerWidth - box.width - margin);
    const y = event.clientY + margin + box.height > window.innerHeight ? event.clientY - box.height - margin : event.clientY + margin;
    tooltip.style.transform = `translate(${Math.max(margin / 2, x)}px, ${Math.max(margin / 2, y)}px)`;
};
const hideTooltip = () => {
    tooltip.hidden = true;
};

const seriesColor = (index) => `var(--s${(index % 8) + 1})`;

// Charts are drawn at the width they are shown, so text stays readable on phones.
const chartWidth = () => {
    const pane = resultsRoot.clientWidth || 900;
    const columns = pane >= 880 ? 2 : 1;
    return Math.round(Math.min(720, Math.max(290, (pane - 14 * (columns - 1)) / columns - 34)));
};

const lineChart = ({ title, xLabels, series, yUnit }) => {
    const width = chartWidth();
    const height = Math.round(Math.min(300, width * 0.62));
    const labelled = series.length <= 4 && width >= 480;
    const margin = { top: 14, right: labelled ? 112 : 18, bottom: 34, left: width >= 480 ? 62 : 52 };
    const plotWidth = width - margin.left - margin.right;
    const plotHeight = height - margin.top - margin.bottom;
    const values = series.flatMap((entry) => entry.values);
    const scale = niceScale(Math.min(...values), Math.max(...values));
    const x = (index) => margin.left + (xLabels.length === 1 ? plotWidth / 2 : (index / (xLabels.length - 1)) * plotWidth);
    const y = (value) => margin.top + plotHeight - ((value - scale.min) / (scale.max - scale.min)) * plotHeight;

    const svg = s('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': title, class: 'chart-svg' });
    for (const tick of scale.ticks) {
        svg.append(
            s('line', { x1: margin.left, x2: width - margin.right, y1: y(tick), y2: y(tick), class: tick === 0 ? 'axis-zero' : 'grid-line' }),
            s('text', { x: margin.left - 8, y: y(tick) + 4, 'text-anchor': 'end', class: 'tick' }, fmt(tick))
        );
    }
    xLabels.forEach((label, index) => svg.append(s('text', { x: x(index), y: height - 12, 'text-anchor': 'middle', class: 'tick' }, label)));
    series.forEach((entry, seriesIndex) => {
        const points = entry.values.map((value, index) => `${x(index)},${y(value)}`).join(' ');
        svg.append(s('polyline', { points, fill: 'none', stroke: seriesColor(seriesIndex), 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
    });
    series.forEach((entry, seriesIndex) => {
        entry.values.forEach((value, index) => svg.append(s('circle', { cx: x(index), cy: y(value), r: 4, fill: seriesColor(seriesIndex), stroke: 'var(--surface)', 'stroke-width': 2 })));
    });
    if (labelled) {
        // Direct labels at the right end, nudged apart so they never overlap.
        const labels = series.map((entry, index) => ({ entry, index, y: y(entry.values.at(-1)) })).sort((a, b) => a.y - b.y);
        labels.forEach((label, order) => {
            if (order > 0 && label.y - labels[order - 1].y < 13) {
                label.y = labels[order - 1].y + 13;
            }
            svg.append(s('text', { x: width - margin.right + 10, y: label.y + 4, class: 'direct-label' }, label.entry.name));
        });
    }
    const guide = s('line', { y1: margin.top, y2: margin.top + plotHeight, class: 'guide', visibility: 'hidden' });
    const hit = s('rect', { x: margin.left, y: margin.top, width: plotWidth, height: plotHeight, fill: 'transparent' });
    const move = (event) => {
        const box = svg.getBoundingClientRect();
        const px = ((event.clientX - box.left) / box.width) * width;
        const index = Math.min(xLabels.length - 1, Math.max(0, Math.round(((px - margin.left) / plotWidth) * (xLabels.length - 1))));
        guide.setAttribute('x1', x(index));
        guide.setAttribute('x2', x(index));
        guide.setAttribute('visibility', 'visible');
        showTooltip(event, [
            h('strong', { text: xLabels[index] }),
            ...series.map((entry, seriesIndex) => h('span', { class: 'tip-line' }, h('i', { class: 'swatch', style: `background:${seriesColor(seriesIndex)}` }), `${entry.name}: ${fmt(entry.values[index])} ${yUnit}`)),
        ]);
    };
    hit.addEventListener('pointermove', move);
    hit.addEventListener('pointerleave', () => {
        guide.setAttribute('visibility', 'hidden');
        hideTooltip();
    });
    svg.append(guide, hit);
    return svg;
};

const barPath = (x0, w, yZero, yValue, radius) => {
    const top = Math.min(yZero, yValue);
    const bottom = Math.max(yZero, yValue);
    const r = Math.min(radius, w / 2, bottom - top);
    if (yValue <= yZero) {
        return `M${x0},${bottom} V${top + r} Q${x0},${top} ${x0 + r},${top} H${x0 + w - r} Q${x0 + w},${top} ${x0 + w},${top + r} V${bottom} Z`;
    }
    return `M${x0},${top} V${bottom - r} Q${x0},${bottom} ${x0 + r},${bottom} H${x0 + w - r} Q${x0 + w},${bottom} ${x0 + w},${bottom - r} V${top} Z`;
};

const barChart = ({ title, labels, values, unit, name }) => {
    const width = chartWidth();
    const height = Math.round(Math.min(280, width * 0.56));
    const margin = { top: 12, right: 12, bottom: 30, left: width >= 480 ? 62 : 52 };
    const plotWidth = width - margin.left - margin.right;
    const plotHeight = height - margin.top - margin.bottom;
    const scale = niceScale(Math.min(...values), Math.max(...values));
    const band = plotWidth / values.length;
    const barWidth = Math.max(2, Math.min(28, band * 0.7));
    const y = (value) => margin.top + plotHeight - ((value - scale.min) / (scale.max - scale.min)) * plotHeight;
    const every = Math.ceil(values.length / Math.max(4, Math.floor(plotWidth / 52)));

    const svg = s('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': title, class: 'chart-svg' });
    for (const tick of scale.ticks) {
        svg.append(
            s('line', { x1: margin.left, x2: width - margin.right, y1: y(tick), y2: y(tick), class: tick === 0 ? 'axis-zero' : 'grid-line' }),
            s('text', { x: margin.left - 8, y: y(tick) + 4, 'text-anchor': 'end', class: 'tick' }, fmt(tick))
        );
    }
    values.forEach((value, index) => {
        const x0 = margin.left + index * band + (band - barWidth) / 2;
        if (value !== 0) {
            svg.append(s('path', { d: barPath(x0, barWidth, y(0), y(value), 4), fill: 'var(--s1)' }));
        }
        if (index % every === 0) {
            svg.append(s('text', { x: x0 + barWidth / 2, y: height - 10, 'text-anchor': 'middle', class: 'tick' }, labels[index]));
        }
        const hit = s('rect', { x: margin.left + index * band, y: margin.top, width: band, height: plotHeight, fill: 'transparent' });
        hit.addEventListener('pointermove', (event) => showTooltip(event, [h('strong', { text: labels[index] }), `${name}: ${fmt(value, 1)} ${unit}`]));
        hit.addEventListener('pointerleave', hideTooltip);
        svg.append(hit);
    });
    return svg;
};

// ---------- results ----------

const selectedCase = () => results.cases[ui.scenario][ui.price];

const pill = (kind, text) => h('span', { class: `pill ${kind}`, text });

const selectRow = () => {
    const make = (label, options, current, onChange) =>
        h(
            'label',
            { class: 'select-field' },
            h('span', { text: label }),
            h(
                'select',
                { onchange: (event) => onChange(Number(event.target.value)) },
                options.map((option, index) => h('option', { value: index, selected: index === current, text: option }))
            )
        );
    return h(
        'div',
        { class: 'selectors' },
        make(
            'Scenario',
            project.scenarios.map((scenario) => scenario.name),
            ui.scenario,
            (value) => ((ui.scenario = value), renderResults())
        ),
        make(
            'Prezzo',
            project.revenue.prices.map((price) => `${fmt(price, 2)} ${project.meta.priceUnit}`),
            ui.price,
            (value) => ((ui.price = value), renderResults())
        ),
        make(
            'Tasso di sconto',
            project.discount.rates.map((rate) => fmtPct(rate, 1)),
            ui.rate,
            (value) => ((ui.rate = value), renderResults())
        )
    );
};

const kpi = (label, value, note, tone) =>
    h('div', { class: 'kpi' }, h('span', { class: 'kpi-label', text: label }), h('strong', { class: `kpi-value${tone ? ` ${tone}` : ''}`, text: value }), note ? h('span', { class: 'kpi-note', text: note }) : null);

const kpiStrip = () => {
    const { meta, equity } = project;
    const current = selectedCase();
    const npvResult = current.npvs[ui.rate];
    const nav = navBridge(project, npvResult.attributable);
    const firstTarget = current.perShare.targets[0];
    return h(
        'div',
        { class: 'kpis' },
        kpi('NPV progetto al 100%', fmt(npvResult.project100), meta.moneyUnit),
        kpi('NPV quota società', fmt(npvResult.attributable), `${meta.moneyUnit} · quota ${fmtPct(project.capital.companyShare)}`),
        kpi(
            'NAV per azione',
            `${fmt(nav.perShareValue, 2)}`,
            `${meta.currency} · ${nav.upside === null ? '' : `${fmtSigned(nav.upside * 100)}% vs prezzo ${fmt(equity.sharePrice, 2)}`}`,
            nav.upside !== null && nav.upside < 0 ? 'neg' : ''
        ),
        firstTarget ? kpi(`Target con P/E ${fmt(firstTarget.multiple)}`, fmt(firstTarget.mean.target, 2), `${meta.currency} su EPS medio · ${fmt(firstTarget.mean.targetLocal, 2)} ${equity.localCurrency}`) : null,
        firstTarget ? kpi('Rendimento atteso', `${fmt(firstTarget.mean.returnMultiple, 1)}×`, `${fmt(equity.investment)} diventano ${fmt(firstTarget.mean.investmentValue)}`) : null
    );
};

const warningsBlock = () => {
    const issues = validateProject(project);
    if (issues.length === 0) {
        return null;
    }
    return h(
        'ul',
        { class: 'issues' },
        issues.map((issue) => h('li', { class: issue.level }, pill(issue.level === 'error' ? 'bad' : 'warn', issue.level === 'error' ? 'Errore' : 'Attenzione'), issue.message))
    );
};

const matrixTable = ({ rateIndex, withOther }) => {
    const base = results.cases.map((row) => row.map((entry) => entry.npvs[rateIndex][ui.basis] + (withOther ? results.otherAssets : 0)));
    const all = base.flat();
    const low = Math.min(...all);
    const high = Math.max(...all);
    const shade = (value) => `color-mix(in srgb, var(--s1) ${Math.round(((value - low) / (high - low || 1)) * 38)}%, transparent)`;
    return h(
        'div',
        { class: 'table-scroll' },
        h(
            'table',
            { class: 'matrix' },
            h(
                'thead',
                {},
                h(
                    'tr',
                    {},
                    h('th', { text: 'Scenario' }),
                    project.revenue.prices.map((price) => h('th', { class: 'num', text: fmt(price, 2) }))
                )
            ),
            h(
                'tbody',
                {},
                project.scenarios.map((scenario, row) =>
                    h(
                        'tr',
                        {},
                        h('th', { scope: 'row', text: scenario.name }),
                        project.revenue.prices.map((_, col) =>
                            h('td', {
                                class: `num${row === ui.scenario && col === ui.price && rateIndex === ui.rate ? ' selected' : ''}`,
                                style: `background:${shade(base[row][col])}`,
                                text: fmt(base[row][col]),
                                title: 'Clicca per vedere il dettaglio',
                                onclick: () => {
                                    ui.scenario = row;
                                    ui.price = col;
                                    ui.rate = rateIndex;
                                    renderResults();
                                },
                            })
                        )
                    )
                )
            )
        )
    );
};

const matrixSection = () => {
    const hasOther = results.otherAssets !== 0 && ui.basis === 'attributable';
    const basisToggle = h(
        'div',
        { class: 'segmented small', role: 'group', 'aria-label': 'Base di calcolo' },
        [
            ['attributable', 'Quota società'],
            ['project100', 'Progetto al 100%'],
        ].map(([value, label]) => h('button', { type: 'button', class: ui.basis === value ? 'on' : '', 'aria-pressed': String(ui.basis === value), text: label, onclick: () => ((ui.basis = value), renderResults()) }))
    );
    return card(
        'NPV per scenario e prezzo',
        `Valori in ${project.meta.moneyUnit}, al netto del capex residuo. Righe: scenari. Colonne: prezzo in ${project.meta.priceUnit}.`,
        basisToggle,
        h(
            'div',
            { class: 'matrix-set' },
            project.discount.rates.map((rate, rateIndex) =>
                h(
                    'div',
                    { class: `matrix-group${hasOther ? ' pair' : ''}` },
                    h('div', {}, h('h4', { text: `NPV a ${fmtPct(rate, 1)}` }), matrixTable({ rateIndex, withOther: false })),
                    hasOther ? h('div', {}, h('h4', { text: `NPV a ${fmtPct(rate, 1)} + altri asset` }), matrixTable({ rateIndex, withOther: true })) : null
                )
            )
        )
    );
};

const chartSection = () => {
    const rateLabel = fmtPct(project.discount.rates[ui.rate], 1);
    const priceSeries = project.scenarios.map((scenario, row) => ({ name: scenario.name, values: results.cases[row].map((entry) => entry.npvs[ui.rate][ui.basis]) }));
    const current = selectedCase();
    const years = project.years.slice(0, Math.max(1, current.simulation.lifeYears));
    const flows = current.simulation.attributableCashFlow.slice(0, years.length);
    return h(
        'div',
        { class: 'chart-pair' },
        card(
            `NPV al variare del prezzo (${rateLabel})`,
            null,
            lineChart({ title: 'NPV per prezzo e scenario', xLabels: project.revenue.prices.map((price) => fmt(price, 2)), series: priceSeries, yUnit: project.meta.moneyUnit }),
            project.scenarios.length > 1
                ? h(
                      'div',
                      { class: 'legend' },
                      project.scenarios.map((scenario, index) => h('span', {}, h('i', { class: 'swatch', style: `background:${seriesColor(index)}` }), scenario.name))
                  )
                : null
        ),
        card(
            `Flusso di cassa annuale della società · ${project.scenarios[ui.scenario].name} a ${fmt(current.price, 2)}`,
            `Post tasse, ${project.meta.moneyUnit}. Dopo il capex residuo di ${fmt(current.npvs[ui.rate].upfrontCapex)} da sostenere prima della produzione.`,
            barChart({ title: 'Flusso di cassa annuale', labels: years.map(String), values: flows, unit: project.meta.moneyUnit, name: 'Flusso società' })
        )
    );
};

const perShareSection = () => {
    const { equity, meta } = project;
    const priceHeads = project.revenue.prices.map((price) => h('th', { class: 'num', text: fmt(price, 2) }));
    const scenarioCases = results.cases[ui.scenario];
    const blocks = equity.peMultiples.map((multiple, multipleIndex) => {
        const row = (label, pick, digits = 2) =>
            h(
                'tr',
                {},
                h('th', { scope: 'row', text: label }),
                scenarioCases.map((entry) => h('td', { class: 'num', text: fmt(pick(entry.perShare.targets[multipleIndex], entry.perShare), digits) }))
            );
        return h(
            'div',
            { class: 'table-scroll' },
            h(
                'table',
                { class: 'matrix' },
                h('thead', {}, h('tr', {}, h('th', { text: `P/E ${fmt(multiple)}` }), priceHeads)),
                h(
                    'tbody',
                    {},
                    row('EPS medio', (_, shares) => shares.epsMean, 3),
                    row(`Target su EPS medio (${meta.currency})`, (target) => target.mean.target),
                    row(`Target su EPS medio (${equity.localCurrency})`, (target) => target.mean.targetLocal),
                    row('Rendimento atteso (×)', (target) => target.mean.returnMultiple, 1),
                    row(`${fmt(equity.investment)} investiti diventano`, (target) => target.mean.investmentValue, 0),
                    h('tr', { class: 'sep' }, h('th', { colspan: String(project.revenue.prices.length + 1), text: `Sull’EPS dell’anno di riferimento (${scenarioCases[0].perShare.referenceYear})` })),
                    row(`EPS ${scenarioCases[0].perShare.referenceYear}`, (_, shares) => shares.epsReference, 3),
                    row(`Target su EPS ${scenarioCases[0].perShare.referenceYear} (${meta.currency})`, (target) => target.reference.target),
                    row(`Target su EPS ${scenarioCases[0].perShare.referenceYear} (${equity.localCurrency})`, (target) => target.reference.targetLocal),
                    row('Rendimento atteso (×)', (target) => target.reference.returnMultiple, 1),
                    row(`${fmt(equity.investment)} investiti diventano`, (target) => target.reference.investmentValue, 0)
                )
            )
        );
    });
    const first = scenarioCases[0].perShare;
    return card(
        `Valore per azione · ${project.scenarios[ui.scenario].name}`,
        `EPS = flusso di cassa post tasse della società ÷ ${fmt(first.shares)} milioni di azioni diluite. EPS medio sui primi ${first.window} anni. Rendimento atteso = target ÷ prezzo attuale (${fmt(equity.sharePrice, 2)} ${meta.currency}). Colonne: prezzo in ${meta.priceUnit}.`,
        h('div', { class: 'matrix-set' }, blocks)
    );
};

const navSection = () => {
    const { meta } = project;
    const current = selectedCase();
    const columns = project.scenarios.map((scenario, index) => {
        const entry = results.cases[index][ui.price];
        const nav = navBridge(project, entry.npvs[ui.rate].attributable);
        return { scenario, nav, funding: fundingCheck(project, scenario) };
    });
    const row = (label, pick, digits = 0, className = '') =>
        h(
            'tr',
            { class: className },
            h('th', { scope: 'row', text: label }),
            columns.map((column) => h('td', { class: 'num', text: pick(column) === null ? '–' : fmt(pick(column), digits) }))
        );
    return h(
        'div',
        { class: 'chart-pair' },
        card(
            `NAV per azione a ${fmt(current.price, 2)} ${meta.priceUnit} e ${fmtPct(project.discount.rates[ui.rate], 1)}`,
            'Valore netto del patrimonio: NPV della società + altri asset + cassa − debito (+ incassi dei warrant). Metrica aggiuntiva rispetto al modello Excel.',
            h(
                'div',
                { class: 'table-scroll' },
                h(
                    'table',
                    { class: 'matrix' },
                    h(
                        'thead',
                        {},
                        h(
                            'tr',
                            {},
                            h('th', { text: meta.moneyUnit }),
                            columns.map((column) => h('th', { class: 'num', text: column.scenario.name }))
                        )
                    ),
                    h(
                        'tbody',
                        {},
                        row('NPV quota società', (c) => c.nav.attributableNpv),
                        row('+ Altri asset (JV)', (c) => c.nav.other),
                        row('+ Cassa', (c) => c.nav.cash),
                        row('− Debito', (c) => -c.nav.debt),
                        row('+ Incassi warrant', (c) => c.nav.warrantProceeds),
                        row('Valore del patrimonio', (c) => c.nav.equityValue, 0, 'total'),
                        row(`NAV per azione (${meta.currency})`, (c) => c.nav.perShareValue, 2, 'total'),
                        row('Capitalizzazione attuale', (c) => c.nav.marketCap),
                        row('Prezzo / NAV', (c) => c.nav.priceToNav, 2)
                    )
                )
            )
        ),
        card(
            'Controllo del finanziamento',
            'Fonti disponibili meno il capex da pagare prima di produrre.',
            h(
                'div',
                { class: 'table-scroll' },
                h(
                    'table',
                    { class: 'matrix' },
                    h(
                        'thead',
                        {},
                        h(
                            'tr',
                            {},
                            h('th', { text: meta.moneyUnit }),
                            columns.map((column) => h('th', { class: 'num', text: column.scenario.name }))
                        )
                    ),
                    h(
                        'tbody',
                        {},
                        row('Capex da finanziare', (c) => c.funding.uses),
                        row('Cassa', (c) => c.funding.cash),
                        row('Linea di credito', (c) => c.funding.debtFacility),
                        row('Incassi warrant', (c) => c.funding.warrantProceeds),
                        row('Fonti totali', (c) => c.funding.sources, 0, 'total'),
                        h(
                            'tr',
                            { class: 'total' },
                            h('th', { scope: 'row', text: 'Avanzo / (fabbisogno)' }),
                            columns.map((column) => h('td', { class: 'num' }, `${fmt(column.funding.surplus)} `, column.funding.surplus >= 0 ? pill('good', 'coperto') : pill('bad', 'scoperto')))
                        )
                    )
                )
            )
        )
    );
};

const annualSection = () => {
    const current = selectedCase();
    const { simulation } = current;
    const factors = discountFactors(project, project.discount.rates[ui.rate]);
    const lines = [
        { label: `Produzione (${project.meta.productionUnit})`, values: simulation.production, digits: 2 },
        { label: `Prezzo realizzato (${project.meta.priceUnit})`, values: simulation.prices, digits: 2, total: false },
        { label: 'Ricavi', values: simulation.revenue, strong: true },
        ...simulation.costLines.map((line) => ({ label: line.name, values: line.values })),
        { label: 'Royalty', values: simulation.royalty },
        { label: 'EBITDA', values: simulation.ebitda, strong: true },
        { label: 'Capex di sviluppo', values: simulation.initialCapex },
        { label: 'Capex di sostenimento', values: simulation.sustainingCapex },
        { label: 'Fondo di chiusura', values: simulation.closureFund },
        { label: 'Capitale circolante', values: simulation.workingCapital },
        { label: 'Flusso ante tasse', values: simulation.preTaxCashFlow, strong: true },
        { label: 'Tasse', values: simulation.tax },
        { label: 'Flusso post tasse (progetto 100%)', values: simulation.postTaxCashFlow, strong: true },
        { label: 'Flusso quota società', values: simulation.attributableCashFlow, strong: true },
        { label: 'Fattore di sconto', values: factors, digits: 3, total: false },
        { label: 'Flusso società scontato', values: simulation.attributableCashFlow.map((value, index) => value * factors[index]) },
    ];
    const header = h(
        'tr',
        {},
        h('th', { class: 'sticky-col', text: '' }),
        h('th', { class: 'num', text: 'Totale' }),
        project.years.map((year) => h('th', { class: 'num', text: String(year) }))
    );
    const body = lines.map((line) =>
        h(
            'tr',
            { class: line.strong ? 'total' : '' },
            h('th', { class: 'sticky-col', scope: 'row', text: line.label }),
            h('td', { class: 'num', text: line.total === false ? '' : fmt(sum(line.values), line.digits ?? 1) }),
            line.values.map((value) => h('td', { class: 'num', text: fmt(value, line.digits ?? 1) }))
        )
    );
    return card(
        `Dettaglio annuale · ${project.scenarios[ui.scenario].name} a ${fmt(current.price, 2)} ${project.meta.priceUnit}`,
        `Valori in ${project.meta.moneyUnit}. Sconto al ${fmtPct(project.discount.rates[ui.rate], 1)}.`,
        h('div', { class: 'table-scroll' }, h('table', { class: 'matrix annual' }, h('thead', {}, header), h('tbody', {}, body)))
    );
};

const csvEscape = (value) => `"${String(value).replaceAll('"', '""')}"`;
const csvNumber = (value) => (Number.isFinite(value) ? String(Math.round(value * 1e6) / 1e6).replace('.', ',') : '');

const buildCsv = () => {
    const lines = [
        [
            'Scenario',
            'Prezzo',
            'Tasso di sconto %',
            'NPV progetto 100%',
            'NPV quota società',
            'NPV quota società + altri asset',
            'NAV per azione',
            'EPS medio',
            ...project.equity.peMultiples.map((multiple) => `Target P/E ${multiple} su EPS medio`),
        ]
            .map(csvEscape)
            .join(';'),
    ];
    results.cases.forEach((row) =>
        row.forEach((entry) =>
            entry.npvs.forEach((result) => {
                const nav = navBridge(project, result.attributable);
                lines.push(
                    [
                        csvEscape(entry.scenario.name),
                        csvNumber(entry.price),
                        csvNumber(result.rate * 100),
                        csvNumber(result.project100),
                        csvNumber(result.attributable),
                        csvNumber(result.attributable + results.otherAssets),
                        csvNumber(nav.perShareValue),
                        csvNumber(entry.perShare.epsMean),
                        ...entry.perShare.targets.map((target) => csvNumber(target.mean.target)),
                    ].join(';')
                );
            })
        )
    );
    return `﻿${lines.join('\r\n')}`;
};

const resultsRoot = h('div', { class: 'results-inner' });

function renderResults() {
    if (!results) {
        return;
    }
    const warnings = warningsBlock();
    const hasError = validateProject(project).some((issue) => issue.level === 'error');
    resultsRoot.replaceChildren(
        ...[
            warnings,
            hasError ? null : h('div', { class: 'selection-bar' }, selectRow()),
            hasError ? null : kpiStrip(),
            hasError ? null : matrixSection(),
            hasError ? null : chartSection(),
            hasError ? null : perShareSection(),
            hasError ? null : navSection(),
            hasError ? null : annualSection(),
        ].filter(Boolean)
    );
}

// ---------- shell: header, tabs, import / export ----------

const formRoot = h('div', { class: 'form-inner' });
const status = h('span', { class: 'status', role: 'status' });
let statusTimer;
const flash = (message) => {
    status.textContent = message;
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => (status.textContent = ''), 3500);
};

function renderForm() {
    const tabs = h(
        'div',
        { class: 'tabs', role: 'tablist' },
        TABS.map((tab) => h('button', { type: 'button', role: 'tab', class: ui.tab === tab.id ? 'on' : '', 'aria-selected': String(ui.tab === tab.id), text: tab.label, onclick: () => ((ui.tab = tab.id), renderForm()) }))
    );
    const scrollTop = document.scrollingElement?.scrollTop ?? 0;
    formRoot.replaceChildren(tabs, tabBuilders[ui.tab]());
    if (document.scrollingElement) {
        document.scrollingElement.scrollTop = scrollTop;
    }
}

const copyText = async (text, successMessage) => {
    try {
        await navigator.clipboard.writeText(text);
        flash(successMessage);
    } catch {
        const area = h('textarea', { class: 'sr-fallback', readonly: true }, text);
        document.body.append(area);
        area.select();
        const copied = document.execCommand?.('copy');
        area.remove();
        flash(copied ? successMessage : 'Copia non riuscita: usa «Scarica».');
    }
};

const download = (filename, text, type) => {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const link = h('a', { href: url, download: filename });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
};

const safeName = () =>
    (project.meta.name || 'progetto')
        .toLowerCase()
        .replaceAll(/[^a-z0-9]+/g, '-')
        .replaceAll(/^-|-$/g, '') || 'progetto';

const loadFromText = (text) => {
    try {
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== 'object' || !parsed.plan) {
            throw new Error('formato');
        }
        setProject(parsed);
        flash('Progetto caricato.');
        return true;
    } catch {
        flash('File non valido: serve un progetto salvato da questo programma (.json).');
        return false;
    }
};

const pastePanel = h(
    'div',
    { class: 'paste-panel', hidden: true },
    h('textarea', { id: 'paste-json', rows: '6', placeholder: 'Incolla qui il JSON del progetto', 'aria-label': 'JSON del progetto' }),
    h(
        'div',
        { class: 'row' },
        h('button', { type: 'button', class: 'btn small', text: 'Carica', onclick: () => loadFromText(document.getElementById('paste-json').value) && (pastePanel.hidden = true) }),
        h('button', { type: 'button', class: 'btn ghost small', text: 'Chiudi', onclick: () => (pastePanel.hidden = true) })
    )
);

const fileInput = h('input', {
    type: 'file',
    accept: '.json,application/json',
    hidden: true,
    onchange: async (event) => {
        const file = event.target.files?.[0];
        if (file) {
            loadFromText(await file.text());
        }
        event.target.value = '';
    },
});

const toolbar = () =>
    h(
        'div',
        { class: 'toolbar' },
        h('button', { type: 'button', class: 'btn ghost small', text: 'Esempio Dasa', onclick: () => (setProject(EXAMPLE_PROJECT), flash('Caricato l’esempio dal modello Excel.')) }),
        h('button', { type: 'button', class: 'btn ghost small', text: 'Nuovo progetto', onclick: () => (setProject(emptyProject()), flash('Progetto vuoto: compila le schede.')) }),
        h('button', { type: 'button', class: 'btn ghost small', text: 'Apri file…', onclick: () => fileInput.click() }),
        h('button', { type: 'button', class: 'btn ghost small', text: 'Incolla JSON…', onclick: () => (pastePanel.hidden = !pastePanel.hidden) }),
        h('span', { class: 'toolbar-sep' }),
        CAN_DOWNLOAD && h('button', { type: 'button', class: 'btn small', text: 'Scarica progetto', onclick: () => download(`${safeName()}.json`, JSON.stringify(project, null, 1), 'application/json') }),
        h('button', { type: 'button', class: 'btn ghost small', text: 'Copia JSON', onclick: () => copyText(JSON.stringify(project, null, 1), 'Progetto copiato negli appunti.') }),
        CAN_DOWNLOAD && h('button', { type: 'button', class: 'btn ghost small', text: 'Scarica risultati (CSV)', onclick: () => download(`${safeName()}-risultati.csv`, buildCsv(), 'text/csv') }),
        h('button', { type: 'button', class: 'btn ghost small', text: 'Copia risultati (CSV)', onclick: () => copyText(buildCsv(), 'Risultati copiati: incollali in Excel.') })
    );

const viewSwitch = h(
    'div',
    { class: 'segmented view-switch', role: 'group', 'aria-label': 'Vista' },
    [
        ['dati', 'Dati'],
        ['risultati', 'Risultati'],
    ].map(([value, label]) =>
        h('button', {
            type: 'button',
            'data-view': value,
            class: ui.view === value ? 'on' : '',
            text: label,
            onclick: () => {
                ui.view = value;
                document.body.dataset.view = value;
                for (const button of viewSwitch.querySelectorAll('button')) {
                    button.classList.toggle('on', button.dataset.view === value);
                }
                window.scrollTo(0, 0);
            },
        })
    )
);

const mount = () => {
    let stored = null;
    try {
        stored = localStorage.getItem(STORAGE_KEY);
    } catch {
        stored = null;
    }
    let initial = EXAMPLE_PROJECT;
    if (stored) {
        try {
            initial = JSON.parse(stored);
        } catch {
            initial = EXAMPLE_PROJECT;
        }
    }
    project = normalizeProject(initial);
    document.body.dataset.view = ui.view;
    const app = document.getElementById('app');
    app.append(
        h(
            'header',
            { class: 'topbar' },
            h(
                'div',
                { class: 'brand' },
                s('svg', { class: 'mark', viewBox: '0 0 24 24', 'aria-hidden': 'true' }),
                h('div', {}, h('h1', { text: 'Simulatore Valore Minerario' }), h('p', { text: 'NPV, valore per azione e scenari di espansione per progetti estrattivi' }))
            ),
            viewSwitch
        ),
        h('div', { class: 'toolbar-wrap' }, toolbar(), status),
        pastePanel,
        fileInput,
        h('main', { class: 'layout' }, h('div', { class: 'pane pane-form' }, formRoot), h('div', { class: 'pane pane-results' }, resultsRoot)),
        h('footer', { class: 'foot', text: 'Le stime sono modelli semplificati a scopo di analisi: non sono consigli di investimento. I dati restano nel tuo browser.' }),
        tooltip
    );
    const mark = app.querySelector('.mark');
    for (const [index, y] of [5, 10, 15, 20].entries()) {
        mark.append(s('rect', { x: 2 + index, y: y - 3, width: 20 - index * 2, height: 3, rx: 1, fill: 'currentColor', opacity: String(1 - index * 0.2) }));
    }
    renderForm();
    recalc();
};

mount();

// Redraw the charts when the layout switches between one and two columns, or the phone rotates.
let lastChartWidth = chartWidth();
let resizeTimer;
window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
        const width = chartWidth();
        if (width !== lastChartWidth) {
            lastChartWidth = width;
            renderResults();
        }
    }, 150);
});
