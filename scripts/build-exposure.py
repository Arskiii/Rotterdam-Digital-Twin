#!/usr/bin/env python3
"""Sample Rotterdam's *modelled* >25 cm flood surface on car-road midpoints.

Requires Pillow. Run after fetch-resilience/build-data. The output is a screening
layer, not a rain-to-water forecast or a street-closure instruction.
"""
import json
import struct
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / 'public' / 'data'
index = json.loads((DATA / 'resilience' / 'index.json').read_text())
meta = json.loads((DATA / 'meta.json').read_text())
image = Image.open(DATA / 'resilience' / 'flood.png').convert('RGBA')
raw = (DATA / 'graph.bin').read_bytes()
position = 0

def read(fmt):
    global position
    size = struct.calcsize('<' + fmt)
    result = struct.unpack_from('<' + fmt, raw, position)
    position += size
    return result if len(result) > 1 else result[0]

assert read('I') == 0x474d5452 and read('I') == 4
nodes = read('I')
position += nodes * 9
signals = read('I')
position += signals * 8
aux = read('I')
position += aux * 12
clusters = read('I')
position += clusters * 12
edges_count = read('I')
assert edges_count == meta['counts']['graphEdges']
edges = []
for edge_id in range(edges_count):
    a, b, cls, flags, speed, length, offset, points, district, mode, name = read('IIBBHfIHBBH')
    edges.append((edge_id, a, b, flags, length, offset, points, district, mode, name))
name_count = read('H')
names = []
for _ in range(name_count):
    name_length = read('B')
    names.append(raw[position:position + name_length].decode('utf-8'))
    position += name_length
geo_count = read('I')
geo = memoryview(raw)[position:position + geo_count * 8]
assert len(geo) == geo_count * 8
corners = index['image']['cornersLocal']
bl, br, _, tl = corners
ax, ay = br[0] - bl[0], br[1] - bl[1]
bx, by = tl[0] - bl[0], tl[1] - bl[1]
det = ax * by - ay * bx

def sample(x, y):
    dx, dy = x - bl[0], y - bl[1]
    u = (dx * by - dy * bx) / det
    v = (ax * dy - ay * dx) / det
    px, py = round(u * (image.width - 1)), round((1 - v) * (image.height - 1))
    if px < 0 or py < 0 or px >= image.width or py >= image.height:
        return None
    return image.getpixel((px, py))[3] >= 32

stats = [{'roadKm': 0.0, 'floodModelRoadKm': 0.0, 'sampledEdges': 0, 'outOfRasterEdges': 0}
         for _ in meta['districts']]
exposed = []
for edge_id, a, b, flags, length, offset, points, district, mode, name_idx in edges:
    if not mode & 1 or flags & 2 or points < 2 or district >= len(stats):
        continue
    first = struct.unpack_from('<ff', geo, offset * 8)
    last = struct.unpack_from('<ff', geo, (offset + points - 1) * 8)
    found = sample((first[0] + last[0]) / 2, (first[1] + last[1]) / 2)
    if found is None:
        stats[district]['outOfRasterEdges'] += 1
        continue
    stats[district]['sampledEdges'] += 1
    stats[district]['roadKm'] += length / 1000
    if found:
        stats[district]['floodModelRoadKm'] += length / 1000
        exposed.append(edge_id)
for stat in stats:
    stat['roadKm'] = round(stat['roadKm'], 2)
    stat['floodModelRoadKm'] = round(stat['floodModelRoadKm'], 2)
    stat['exposurePct'] = round(100 * stat['floodModelRoadKm'] / stat['roadKm'], 1) if stat['roadKm'] else None
out = {
    'schemaVersion': 1,
    'source': index['source'],
    'sourceLayer': index['layers']['flood']['sourceLayer'],
    'retrievedAt': index['retrievedAt'],
    'graphEdges': edges_count,
    'method': 'car-accessible, non-tunnel road midpoint sampled against modelled >25 cm water raster; not a forecast',
    'districts': [{'name': d['name'], **stat} for d, stat in zip(meta['districts'], stats)],
    'exposedEdges': exposed,
    'erasmusBridgeEdges': [edge_id for edge_id, a, b, flags, length, offset, points, district, mode, name_idx in edges
                           if mode & 1 and name_idx < len(names) and names[name_idx] == 'Erasmusbrug'],
}
(DATA / 'exposure.json').write_text(json.dumps(out, separators=(',', ':')) + '\n')
print('wrote', len(exposed), 'modelled road exposures in', len(stats), 'districts')
