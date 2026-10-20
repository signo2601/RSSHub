"""Builds the example project and the Excel reference values from the original workbook.

Usage: python3 -I tools/extract_example.py <workbook.xlsx> <examples_dir> <fixtures_dir>
"""
import json
import sys

import openpyxl
from openpyxl.utils import column_index_from_string as col

path, examples_dir, fixtures_dir = sys.argv[1], sys.argv[2], sys.argv[3]
values = openpyxl.load_workbook(path, data_only=True)
sheet = values['110$ update']

FIRST, LAST = col('F'), col('AC')  # 2028 .. 2051
YEARS = [sheet.cell(6, c).value for c in range(FIRST, LAST + 1)]


def row(r, last=LAST):
    out = []
    for c in range(FIRST, LAST + 1):
        v = sheet.cell(r, c).value if c <= last else None
        out.append(round(float(v), 6) if isinstance(v, (int, float)) else 0)
    return out


project = {
    'schemaVersion': 1,
    'meta': {
        'name': 'Dasa (esempio dal modello Excel)',
        'company': 'Global Atomic',
        'commodity': 'Uranio (U3O8)',
        'productionUnit': 'Mlb',
        'priceUnit': 'US$/lb',
        'currency': 'US$',
        'moneyUnit': 'M US$',
    },
    'years': YEARS,
    'plan': {
        'production': row(7),
        'costLines': [
            {'name': 'Miniera', 'variableShare': sheet['B31'].value, 'values': row(9)},
            {'name': 'Trattamento', 'variableShare': sheet['B32'].value, 'values': row(10)},
            {'name': 'Sito Niamey', 'variableShare': sheet['B33'].value, 'values': row(11)},
            {'name': 'Vendita', 'variableShare': sheet['B34'].value, 'values': row(12)},
        ],
        'sustainingCapex': {'variableShare': sheet['B38'].value, 'values': row(16)},
        'closureFund': row(17),
        'workingCapital': row(18),
        'initialCapex': row(15),
    },
    'revenue': {
        'prices': [110, 130, 150, 170],
        'realizationFactor': 0.9,
        'realizationYears': 5,
        'escalation': 0,
        'royaltyRate': 0.06903,
    },
    'scenarios': [
        {'name': 'Piano base (FS)', 'production': None, 'additionalCapex': 0, 'efficiency': 1},
        {'name': '1200 tpd', 'production': row(28), 'additionalCapex': 0, 'efficiency': sheet['B28'].value},
        {'name': '1325 tpd', 'production': row(59, col('AA')), 'additionalCapex': sheet['A79'].value - sheet['A47'].value, 'efficiency': 1},
        {'name': '2000 tpd', 'production': row(91, col('W')), 'additionalCapex': sheet['A111'].value - sheet['A47'].value, 'efficiency': 1},
    ],
    'tax': {'rate': 0.3, 'holidayYears': 3, 'openingPool': 37},
    'capital': {
        'remainingCapex': sheet['A47'].value,
        'companyShare': 0.8,
        'capexShare': 1,
        'cash': 42.4,
        'debt': 0,
        'debtFacility': 295,
        'warrantProceeds': 218,
        'includeWarrantProceedsInNav': True,
    },
    'discount': {'rates': [0.08, 0.10, 0.12], 'midYear': False, 'valuationYear': None},
    'equity': {
        'shares': sheet['E121'].value,
        'warrants': sheet['E122'].value,
        'sharePrice': 0.28,
        'fx': 1.43,
        'localCurrency': 'C$',
        'peMultiples': [20, 15],
        'averageYears': 15,
        'referenceYear': 2029,
        'investment': 10000,
    },
    'otherAssets': [
        {'name': 'Befesa Silvermet Turkey (JV) - valore di ESEMPIO: 6x EBITDA 2025, da sostituire', 'value': 85, 'stake': 0.49},
    ],
}

# Reference values read from the workbook's 1200 tpd block (rows 28-52), one sheet per uranium price.
reference = {}
for price, name in [(110, '110$ update'), (130, '130$ update'), (150, '150$ update'), (170, '170$ update')]:
    ws = values[name]
    tax_cells = {}
    formulas = openpyxl.load_workbook(path, data_only=False)[name]
    for c in range(FIRST, FIRST + 8):
        f = formulas.cell(42, c).value
        if isinstance(f, str) and '-' in f:
            tax_cells[str(ws.cell(6, c).value)] = f
    reference[str(price)] = {
        'taxFormulas1200': tax_cells,
        'revenue': ws['E30'].value,
        'ebitda': ws['E36'].value,
        'taxes': ws['E42'].value,
        'postTax': ws['E43'].value,
        'npv100': {'8': ws['E47'].value, '10': ws['E49'].value, '12': ws['E51'].value},
        'npvCompany': {'8': ws['E48'].value, '10': ws['E50'].value, '12': ws['E52'].value},
        'remainingCapex': ws['A47'].value,
        'npvCompany1325': {'8': ws['E79'].value, '10': ws['E81'].value, '12': ws['E83'].value},
        'npvCompany2000': {'8': ws['E111'].value, '10': ws['E113'].value, '12': ws['E115'].value},
    }

with open(f'{examples_dir}/global-atomic-dasa.json', 'w') as f:
    json.dump(project, f, indent=1, ensure_ascii=False)
with open(f'{fixtures_dir}/excel-reference.json', 'w') as f:
    json.dump(reference, f, indent=1)
print('written', len(YEARS), 'years')
