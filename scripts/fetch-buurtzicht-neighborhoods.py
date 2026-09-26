#!/usr/bin/env python3
"""Snapshot CBS 2025 Rotterdam totals exposed as open JSON by BuurtZicht.

Use only when the official CBS workbook cannot be reached. The selected fields
are published aggregate counts; this importer keeps their upstream provenance.
"""
import json
import re
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BASE = 'https://buurtzicht.nl'
INDEX = f'{BASE}/gemeente/gm0599-rotterdam/'
TARGET = ROOT / 'public' / 'data' / 'cbs-neighborhoods.json'
HEADERS = {'User-Agent': 'Rotterdam-Digital-Twin/1.0 (public aggregate data; contact via GitHub)'}


def read(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers=HEADERS), timeout=30) as response:
        if response.status != 200:
            raise RuntimeError(f'{url}: HTTP {response.status}')
        content = response.read(2 * 1024 * 1024 + 1)
        if len(content) > 2 * 1024 * 1024:
            raise RuntimeError(f'{url}: response too large')
        return content


def metric(record, name):
    for group in record['metrics'].values():
        for item in group:
            if item['id'] == name:
                value = item.get('value')
                return round(value) if isinstance(value, (float, int)) and value >= 0 else None
    return None


def neighborhood(code):
    url = f'{BASE}/data/buurten/{code}.json'
    record = json.loads(read(url))
    identity = record['identity']
    if identity['code'] != code or identity['gemeenteCode'] != 'GM0599' or record['year'] != 2025:
        raise RuntimeError(f'{code}: unexpected identity or year')
    if not any(source.get('tableId') == '86165NED' and source.get('provider') == 'CBS'
               for source in record['sources']):
        raise RuntimeError(f'{code}: CBS 2025 attribution missing')
    residents = metric(record, 'population_total')
    if residents is None:
        raise RuntimeError(f'{code}: resident count missing')
    age65 = next((item.get('count') for item in record['distributions']['age']
                  if item['id'] == 'age_65_plus'), None)
    if age65 is not None and (not isinstance(age65, (float, int)) or age65 < 0 or age65 > residents):
        raise RuntimeError(f'{code}: invalid 65+ count')
    return {
        'code': code, 'name': identity['name'], 'residents': residents,
        'age65Plus': round(age65) if age65 is not None else None,
        'households': metric(record, 'households_total'),
        'lowIncomeHouseholdsPct': None,
    }


codes = sorted(set(code.upper() for code in re.findall(rb'/buurt/(bu0599\d{4})/', read(INDEX), re.I)))
codes = [code.decode('ascii') if isinstance(code, bytes) else code for code in codes]
if not 80 <= len(codes) <= 150:
    raise SystemExit(f'Unexpected Rotterdam neighborhood coverage: {len(codes)}')
with ThreadPoolExecutor(max_workers=4) as pool:
    rows = list(pool.map(neighborhood, codes))
TARGET.write_text(json.dumps({
    'schemaVersion': 1,
    'publisher': 'CBS',
    'dataset': 'Kerncijfers wijken en buurten 2025',
    'datasetId': '86165NED',
    'source': INDEX,
    'sourceDetail': 'BuurtZicht open JSON profiles derived from CBS table 86165NED; https://buurtzicht.nl/data/buurten/{code}.json',
    'retrievedAt': datetime.now(timezone.utc).isoformat(),
    'license': 'CBS CC BY 4.0',
    'geography': 'CBS BU0599 neighbourhoods, municipality Rotterdam',
    'caveat': 'CBS 2025 aggregate figures accessed through BuurtZicht because the CBS download endpoint was unavailable. Low-income share is not supplied and is null. Counts may be rounded by CBS; geography differs from the simulation district boundary.',
    'neighborhoods': rows,
}, ensure_ascii=False, separators=(',', ':')) + '\n')
print(f'Wrote {len(rows)} Rotterdam neighborhoods via BuurtZicht to {TARGET}')
