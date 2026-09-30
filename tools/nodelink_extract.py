"""
nodelink_extract.py — 국가 표준노드링크(전국 SHP)에서 시험 경로 주변 링크의 차로 수만 뽑아
                      앱이 읽는 작은 JSON(data/nodelink-lanes.json)으로 만든다

자료: 국토교통부 국가교통정보센터 '전국표준노드링크' (https://www.its.go.kr/nodelink/nodelinkRef)
      이용허락범위 제한 없음 (공공데이터포털 15025526)

준비:  pip install pyshp pyproj
실행:  python3 tools/nodelink_extract.py <NODELINKDATA.zip 또는 풀어 둔 폴더> <경로.geojson> [<경로.geojson> …]
       · 경로 파일 = TMAP 자동차 경로 응답(GeoJSON)을 저장한 것. 경로 선에서 BUFFER_M 안의 링크만 남긴다
       · 결과: data/nodelink-lanes.json  (링크마다 [차로 수, [위도, 경도, 위도, 경도, …]])
"""
import json, math, os, sys, tempfile, zipfile

import shapefile                      # pyshp
from pyproj import CRS, Transformer

BUFFER_M = 150        # 경로 선에서 이 거리 안의 링크를 남긴다 (경로를 조금 벗어나 다시 찾을 때 대비)
CELL_M = 50           # 근처 판정용 격자


def find_link_shp(src):
    """zip이면 임시 폴더에 풀고, MOCT_LINK.shp 경로를 돌려준다"""
    if zipfile.is_zipfile(src):
        out = tempfile.mkdtemp(prefix='nodelink_')
        with zipfile.ZipFile(src) as z:
            z.extractall(out)
            for n in z.namelist():                         # zip 안에 zip이 또 있는 경우
                if n.lower().endswith('.zip'):
                    with zipfile.ZipFile(os.path.join(out, n)) as z2:
                        z2.extractall(os.path.join(out, os.path.splitext(n)[0]))
        src = out
    for root, _, files in os.walk(src):
        for f in files:
            if f.upper() == 'MOCT_LINK.SHP':
                return os.path.join(root, f)
    sys.exit('MOCT_LINK.shp를 찾지 못함: ' + src)


def route_lines(paths):
    """TMAP 경로 GeoJSON → [[(lon, lat), …], …]"""
    lines = []
    for p in paths:
        geo = json.load(open(p, encoding='utf-8'))
        pts = []
        for f in geo.get('features', []):
            g = f.get('geometry') or {}
            if g.get('type') == 'LineString':
                pts += [tuple(c) for c in g['coordinates']]
        if len(pts) > 1:
            lines.append(pts)
    if not lines:
        sys.exit('경로 파일에서 선을 찾지 못함')
    return lines


def main():
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    shp = find_link_shp(sys.argv[1])
    lines = route_lines(sys.argv[2:])

    prj = os.path.splitext(shp)[0] + '.prj'
    crs = CRS.from_wkt(open(prj, encoding='utf-8', errors='ignore').read()) if os.path.exists(prj) else CRS.from_epsg(5186)
    to_xy = Transformer.from_crs('EPSG:4326', crs, always_xy=True)
    to_ll = Transformer.from_crs(crs, 'EPSG:4326', always_xy=True)
    print('좌표계:', crs.name)

    # 경로 선을 10m 간격으로 훑어, BUFFER_M 안에 드는 격자 칸 모음
    cells, reach = set(), math.ceil(BUFFER_M / CELL_M)
    xs, ys = [], []
    for line in lines:
        xy = [to_xy.transform(lon, lat) for lon, lat in line]
        for (x0, y0), (x1, y1) in zip(xy, xy[1:]):
            n = max(1, int(math.hypot(x1 - x0, y1 - y0) // 10))
            for k in range(n + 1):
                x, y = x0 + (x1 - x0) * k / n, y0 + (y1 - y0) * k / n
                xs.append(x); ys.append(y)
                ci, cj = int(x // CELL_M), int(y // CELL_M)
                for di in range(-reach, reach + 1):
                    for dj in range(-reach, reach + 1):
                        cells.add((ci + di, cj + dj))
    bbox = [min(xs) - BUFFER_M, min(ys) - BUFFER_M, max(xs) + BUFFER_M, max(ys) + BUFFER_M]

    sf = shapefile.Reader(shp, encoding=(open(os.path.splitext(shp)[0] + '.cpg').read().strip() if os.path.exists(os.path.splitext(shp)[0] + '.cpg') else 'cp949'))
    names = [f[0] for f in sf.fields[1:]]
    print('필드:', ', '.join(names))
    if 'LANES' not in names:
        sys.exit('LANES 필드가 없음')

    links, lane_hist = [], {}
    for sr in sf.iterShapeRecords(bbox=bbox):
        pts = sr.shape.points
        if len(pts) < 2:
            continue
        if not any((int(x // CELL_M), int(y // CELL_M)) in cells for x, y in pts[:: max(1, len(pts) // 20)] + [pts[-1]]):
            continue
        rec = sr.record.as_dict()
        lanes = int(rec.get('LANES') or 0)
        lane_hist[lanes] = lane_hist.get(lanes, 0) + 1
        flat = []
        for x, y in pts:
            lon, lat = to_ll.transform(x, y)
            flat += [round(lat, 6), round(lon, 6)]
        links.append([lanes, flat])

    out_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'data')
    os.makedirs(out_dir, exist_ok=True)
    out = os.path.join(out_dir, 'nodelink-lanes.json')
    meta = {
        'source': '국토교통부 국가교통정보센터 전국표준노드링크 (' + os.path.basename(sys.argv[1]) + ')',
        'license': '이용허락범위 제한 없음 (공공데이터포털 15025526)',
        'note': '시험 경로 주변 ' + str(BUFFER_M) + 'm 안 링크만. 링크는 방향별로 따로 있고 LANES는 그 방향 차로 수',
        'links': links,
    }
    json.dump(meta, open(out, 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
    print('링크', len(links), '개 →', out, f'({os.path.getsize(out) / 1024:.0f} KB)')
    print('차로 수 분포:', dict(sorted(lane_hist.items())))


if __name__ == '__main__':
    main()
