#!/usr/bin/env python3
"""Regenerate the architecture docs and optional Miro DSL (Python stdlib only).

Run: python3 ops/architecture/build.py [--miro-dir /tmp/photography-atlas]
This writes local documentation only. Miro publishing is a separate operation.
"""
import argparse
import html
import json
from pathlib import Path
import re

from model import VIEWS

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
BOARD = "https://miro.com/app/board/uXjVHsf6LH0=/"
PALETTE = {
    "actor": ("#EAF2FF", "#3864A3"),
    "edge": ("#E8F6F6", "#287C83"),
    "app": ("#EFF1FC", "#606AAF"),
    "data": ("#FFF3DB", "#A7792B"),
    "job": ("#FCEEE5", "#AF704A"),
    "security": ("#F9EAF0", "#A65774"),
    "provider": ("#F1EBF8", "#86639D"),
    "ops": ("#EDF2F5", "#62798A"),
}


def mermaid(v):
    lines = ["flowchart TB"]
    for k, (fill, stroke) in PALETTE.items():
        lines.append(f"  classDef {k} fill:{fill},stroke:{stroke},color:#172B3A,stroke-width:1.5px")
    for ri, row in enumerate(v["lanes"]):
        lines += [f'  subgraph lane{ri}["{row["title"]}"]', "    direction LR"]
        for ci, n in enumerate(row["nodes"]):
            label = html.escape(n["title"], quote=False) + "<br/>" + html.escape(n["detail"], quote=False).replace("\n", "<br/>")
            lines.append(f'    n{ri}{ci}["{label}"]:::{n["kind"]}')
        for ci, label in enumerate(row["labels"]):
            if label is None:
                lines.append(f"    n{ri}{ci} ~~~ n{ri}{ci+1}")
                continue
            arrow = f'-. "{label}" .->' if row["dashed"] else f'-->|"{label}"|'
            lines.append(f"    n{ri}{ci} {arrow} n{ri}{ci+1}")
        lines += ["  end", f"  style lane{ri} fill:#FAFBFD,stroke:#DCE3EB,color:#526578"]
    lines.append("  %% Invisible links only stack lanes; they do not represent system relationships.")
    for ri in range(len(v["lanes"]) - 1):
        lines.append(f"  lane{ri} ~~~ lane{ri+1}")
    return "\n".join(lines) + "\n"


def resource_blocks(path):
    """Read the repository's explicit top-level CloudFormation resource blocks.

    This is intentionally an inventory reader, not a YAML interpreter. It does
    not resolve intrinsics, evaluate deployment conditions or expand SAM.
    """
    text = path.read_text()
    start = text.index("\nResources:\n") + 1
    tail = text[start:]
    end = re.search(r"\n[A-Za-z][A-Za-z0-9]*:", tail[len("Resources:"):])
    if end:
        tail = tail[:len("Resources:") + end.start()]
    matches = list(re.finditer(r"^  (\w+):\n(?=    (?:Type:|#))", tail, re.M))
    rows = []
    for i, m in enumerate(matches):
        body = tail[m.end():matches[i+1].start() if i+1 < len(matches) else len(tail)]
        kind = re.search(r"^    Type: (.+)$", body, re.M)
        if kind:
            rows.append({"id": m[1], "type": kind[1], "body": body,
                         "line": text[:start + m.start()].count("\n") + 1})
    return rows


def field(body, key, indent=6):
    m = re.search(rf"^{' ' * indent}{key}: (.+)$", body, re.M)
    return m[1].replace("|", "&#124;") if m else "—"


def inventory():
    app = resource_blocks(ROOT / "backend/template.yaml")
    assert app and len(app) == len(re.findall(r"^    Type: AWS::", (ROOT / "backend/template.yaml").read_text(), re.M))
    routes = []
    source = (ROOT / "src/App.jsx").read_text()
    for match in re.finditer(r'<Route path="([^"]+)" element=\{(.+?)\} />', source):
        route, element = match.groups()
        page = re.findall(r"<([A-Z]\w+)", element)[-1]
        policy = "Admins + UI MFA gate" if "adminOnly" in element else "Signed-in client" if "ProtectedRoute" in element else "Public shell; resource authorization applies"
        if "allowMfaSetup" in element:
            policy = "Admins; MFA enrollment allowed"
        routes.append((route, page, policy))
    assert len(routes) == source.count("<Route path=")
    explore = re.findall(r"pathname === '([^']+)'", (ROOT / "src/pages/Explore.jsx").read_text())
    lines = ["# Architecture source inventory", "", "Generated from checked-in source by [build.py](architecture/build.py). Read the [architecture atlas](ARCHITECTURE.md) for relationships. This inventory does not evaluate stack conditions or assert that a resource is deployed.", "", "## Browser routes", "", "| URL | Page component | Access boundary |", "|---|---|---|"]
    lines += [f"| `{url}` | `{page}` | {access} |" for url, page, access in routes]
    lines += [f"| `{url}` | `Explore` subview | Public discovery |" for url in explore]
    lines += ["| `prints.iantruongphotography.com/print.html` | `print-main.js` | Separate origin; scoped print capability |", "", "## HTTP API routes", "", "Paths below are API Gateway paths; browser requests prefix them with `/api`. `JWT` is the default Gateway authorizer. `Handler policy` means the Gateway route is open and the handler still enforces the front door, validation, public/owner/admin/share policy and rate/bot checks as appropriate.", "", "| Method and path | Lambda logical ID | Gateway authentication |", "|---|---|---|"]
    api_count = 0
    for res in app:
        events = list(re.finditer(r"^        (\w+):\n          Type: (\w+)\n", res["body"], re.M))
        res["events"] = []
        for i, event in enumerate(events):
            body = res["body"][event.end():events[i+1].start() if i+1 < len(events) else len(res["body"])]
            if event[2] == "HttpApi":
                path, method = field(body, "Path", 12), field(body, "Method", 12)
                auth = "Handler policy" if "Authorizer: NONE" in body else "JWT"
                lines.append(f"| `{method} {path}` | `{res['id']}` | {auth} |")
                api_count += 1
            else:
                trigger = field(body, "Schedule", 12)
                if trigger == "—":
                    trigger = field(body, "Queue", 12) if event[2] == "SQS" else field(body, "Stream", 12)
                enabled = field(body, "Enabled", 12)
                res["events"].append(f"{event[2]}: {trigger}" + (f"; Enabled={enabled}" if enabled != "—" else ""))
    assert api_count == len(re.findall(r"^            Path:", (ROOT / "backend/template.yaml").read_text(), re.M))
    lines += ["", "## Every application function", "", "HTTP functions map to the route table above. A function with no event mapping is invoked by application code; concurrency `inherited` means no per-function override is declared. Globals set default runtime/environment/logging. Failure paths remain source-specific.", "", "| Logical ID | Handler | Background triggers | Reserved concurrency |", "|---|---|---|---|"]
    functions = [r for r in app if r["type"] == "AWS::Serverless::Function"]
    for r in functions:
        lines.append(f"| `{r['id']}` | `{field(r['body'], 'Handler')}` | {'<br/>'.join(r['events']) or 'HTTP or direct application invocation'} | {field(r['body'], 'ReservedConcurrentExecutions').replace('—', 'inherited')} |")
    lines += ["", "## Function-to-resource dependencies", "", "These are explicit application-resource references in each function's template block (environment, triggers, IAM permissions and failure routing). A reference is a declared dependency or allowed access, not proof of a runtime call. Shared Globals also wire the Cognito pool/client, frontend origin, release identity, centralized logs and front-door configuration. This table makes the detailed connections inspectable without crowding the diagrams.", "", "| Function | Declared application-resource dependencies |", "|---|---|"]
    app_ids = {r["id"] for r in app}
    for r in functions:
        body = re.sub(r"^\s*#.*$", "", r["body"], flags=re.M)
        refs = set(re.findall(r"!(?:Ref|GetAtt)\s+([A-Za-z0-9]+)", body))
        refs.update(re.findall(r"\$\{([A-Za-z0-9]+)(?:\.[^}]+)?\}", body))
        refs = sorted((refs & app_ids) - {r["id"]})
        lines.append(f"| `{r['id']}` | " + ", ".join(f"`{ref}`" for ref in refs) + " |")
    lines += ["", "## Application data and storage", "", "The ten DynamoDB tables are retained, deletion-protected and have PITR. Only AlbumsTable and PreviewMetadataTable are selected by the checked-in daily AWS Backup plan. Table keys below describe storage identity, not authorization grants.", "", "| Resource | Type | Keys or object responsibility |", "|---|---|---|"]
    data = {
        "AlbumsTable": "albumId; active status, visibility, ownerSub, share state, legacy manifest; share/visibility/summary/owner GSIs",
        "GallerySettingsTable": "settingId; gallery order and section presentation",
        "AlbumMediaTable": "albumId + mediaId; AlbumOrderIndex(albumId, orderKey); normalized media",
        "PreviewMetadataTable": "albumId + mediaId; previews, Explore refs/markers, hover pointers, random pools; KEYS_ONLY stream",
        "OriginalComparisonTable": "albumId + mediaId; original matching state and private index pointer",
        "RateLimitTable": "identifier; TTL ttl; rate limits, challenges and bounded grants",
        "CostReportCacheTable": "cacheKey; Cost Explorer report cache",
        "AnalyticsTable": "bucket + metric; TTL ttl; anonymous aggregate telemetry",
        "DriveUsageCacheTable": "cacheKey; Google Drive usage snapshots",
        "GitHubAnalyticsCacheTable": "cacheKey; repository analytics snapshots",
        "ImagesBucket": "albums/ source and derivatives; site/hero/; temp-zips/; fotomoto/references/; versioning + visibility tags",
        "OriginalPreviewBucket": "index/ private snapshots (7-day expiry); before/ immutable private WebP derivatives; no public CDN alias",
        "MediaAccessLogsBucket": "S3/media CloudFront access logs; retained, private logging destination",
    }
    actual_data = {r["id"] for r in app if r["type"] in ["AWS::DynamoDB::Table", "AWS::S3::Bucket"]}
    assert actual_data == set(data), f"Update data coverage: {actual_data ^ set(data)}"
    for r in app:
        if r["id"] in data:
            lines.append(f"| `{r['id']}` | `{r['type']}` | {data[r['id']]} |")
    lines += ["", "The existing private frontend S3 bucket belongs to the frontend delivery boundary managed by `ops/cloudfront_frontend.py`, outside the SAM bucket inventory. The release bootstrap and ops stacks own their separate artifact, audit, Config and recovery stores.", "", "## Complete infrastructure inventory", "", "Every explicit CloudFormation/SAM logical resource in the application and supporting templates is listed below, including policies, event mappings, certificates, log groups, alarms, queues, backup resources and security services. SAM-generated implicit resources are not expanded. Conditions are displayed without evaluation."]
    templates = [ROOT / "backend/template.yaml"] + sorted((ROOT / "ops").glob("*.yaml"))
    count = 0
    for template in templates:
        if "\nResources:\n" not in template.read_text():
            continue
        rel = template.relative_to(ROOT).as_posix()
        blocks = resource_blocks(template)
        expected = len(re.findall(r"^    Type: (?:AWS::|Custom::)", template.read_text(), re.M))
        assert len(blocks) == expected, (rel, len(blocks), expected)
        count += len(blocks)
        lines += ["", f"### {rel}", "", "| Logical resource | Type | Condition |", "|---|---|---|"]
        for r in blocks:
            lines.append(f"| [`{r['id']}`](../{rel}#L{r['line']}) | `{r['type']}` | {field(r['body'], 'Condition', 4)} |")
    lines += ["", "## Coverage", "", f"- {len(routes)} top-level React routes, {len(explore)} explicit Explore subroutes, and the isolated print entry.", f"- {api_count} HTTP API mappings and {len(functions)} application Lambda functions.", f"- {len(actual_data)} application tables/buckets and {count} explicit resources across {len(templates)} infrastructure templates.", "- All 12 diagram views share one model; Miro shapes and Mermaid labels/connections are generated from it.", "- Full alarm/runbook ownership: [ALARM_REGISTRY.md](ALARM_REGISTRY.md) and [alarm_registry.json](alarm_registry.json).", ""]
    return "\n".join(lines), dict(routes=len(routes), explore_subroutes=len(explore), api_routes=api_count, functions=len(functions), data_resources=len(actual_data), infrastructure_resources=count, templates=len(templates))


def miro_dsl(v, i):
    # A fixed 4-column grid provides real whitespace for labels and zero crossings.
    frame = f"f{i}"
    fx, fy = (i % 3) * 3060 + 1420, (i // 3) * 2280 + 1050
    lines = [f'{frame} FRAME x={fx} y={fy} w=2840 h=2100 fill=#FFFFFF "{v["title"]}"']
    def txt(alias, x, y, w, size, content, color="#526578"):
        lines.append(f'{alias} TEXT parent={frame} x={x} y={y} w={w} font=plex_sans size={size} color={color} align=left "{content}"')
    txt(f"h{i}", 1420, 85, 2680, 46, html.escape(v["title"]), "#172B3A")
    txt(f"s{i}", 1420, 158, 2680, 30, html.escape(v["subtitle"]))
    for ri, row in enumerate(v["lanes"]):
        y = 430 + ri * 385
        txt(f"l{i}r{ri}", 1420, y-138, 2680, 22, html.escape(row["title"]))
        for ci, n in enumerate(row["nodes"]):
            x = 385 + ci * 690
            fill, stroke = PALETTE[n["kind"]]
            alias = f"n{i}r{ri}c{ci}"
            content = "<p><strong>" + html.escape(n["title"]) + "</strong></p><p>" + html.escape(n["detail"]).replace("\n", "<br>") + "</p>"
            lines.append(f'{alias} SHAPE parent={frame} x={x} y={y} w=540 h=212 type=round_rectangle fill={fill} color=#172B3A font=plex_sans size=30 align=center valign=middle border_color={stroke} border_width=1.5 "{content}"')
        for ci, label in enumerate(row["labels"]):
            if label is None:
                continue
            lines.append(f'e{i}r{ri}c{ci} CONNECTOR from=n{i}r{ri}c{ci} to=n{i}r{ri}c{ci+1} shape=straight stroke_color=#62798A stroke_style={"dashed" if row["dashed"] else "normal"} start_cap=none end_cap=arrow start_snap=right end_snap=left ""')
            # Native connector captions have an unconfigurable small font in
            # the DSL. Explicit label objects keep them legible at frame zoom.
            lines.append(f'edgeLabel{i}r{ri}c{ci} TEXT parent={frame} x={730 + ci * 690} y={y + 150} w=500 font=plex_sans size=26 color=#526578 align=center "{html.escape(label)}"')
    # Detailed boundary notes remain comfortably readable at frame zoom.
    txt(f"b{i}", 1420, 1910, 2630, 21, "<p><strong>BOUNDARIES AND CONNECTIONS</strong></p><p>" + html.escape(v["notes"]) + "</p>")
    return "\n".join(lines) + "\n"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--miro-dir", type=Path)
    args = parser.parse_args()
    for v in VIEWS:
        for source in v["sources"]:
            assert (ROOT / source).is_file(), source
        assert len(v["lanes"]) <= 4
        assert all(len(row["nodes"]) <= 4 for row in v["lanes"])
    (HERE / "mermaid").mkdir(exist_ok=True)
    diagrams = []
    for v in VIEWS:
        code = mermaid(v)
        (HERE / "mermaid" / (v["slug"] + ".mmd")).write_text(code)
        diagrams.append(code)
    inv, counts = inventory()
    (ROOT / "ops/ARCHITECTURE_INVENTORY.md").write_text(inv)
    mapping_path = HERE / "miro-map.json"
    mapping = json.loads(mapping_path.read_text()) if mapping_path.exists() else {}
    docs = ["# Website architecture atlas", "", "Source-backed views of Ian Truong Photography. Start with 00, then use the numbered views to follow a specific journey. The [editable Miro board](" + BOARD + ") uses the same nodes and relationships. [Complete source inventory](ARCHITECTURE_INVENTORY.md) lists every route, application function, data store and explicit infrastructure resource.", "", "## How to read the atlas", "", "Each horizontal lane is one request, data or control flow, read left to right. Solid arrows represent requests or data movement; dashed arrows represent scheduled/control/operational work. A label states what crosses the boundary. Unconnected cards are separate controls or conditional resources, not implied data flows. Repeated names refer to the same component across views; numbered references avoid long arrows across unrelated sections.", "", "Colors: blue = people/browser entry; teal = edge/delivery; lavender = app logic; amber = data; peach = workers; rose = access/security; purple = external provider; gray = operations. Labels carry the meaning without relying on color.", "", "**Scope:** current checked-in source and documented production intent. Deployment switches and optional resources are identified explicitly. This work does not claim a fresh live AWS inventory or provider configuration audit.", "", "## Views", "", "| View | Question answered |", "|---|---|"]
    for v in VIEWS:
        anchor = v["slug"]
        docs.append(f"| [{v['title']}](#{anchor}) | {v['subtitle']} |")
    for v, code in zip(VIEWS, diagrams):
        miro_url = mapping.get("views", {}).get(v["slug"])
        detail_link = f" [Open this view in Miro]({miro_url})." if miro_url else ""
        docs += ["", f'<a id="{v["slug"]}"></a>', "", f"## {v['title']}", "", v["subtitle"] + detail_link, "", "```mermaid", code.rstrip(), "```", "", v["notes"], "", "Sources: " + ", ".join(f"[{p}](../{p})" for p in v["sources"]) + "."]
    docs += ["", "## Maintenance", "", "Edit [architecture/model.py](architecture/model.py), then run `python3 ops/architecture/build.py`. This regenerates all Mermaid files, this atlas, the README overview and the source inventory. Add `--miro-dir /tmp/photography-atlas` to generate matching native-shape Miro DSL for an authorized board update. The command itself never modifies Miro or AWS.", "", "Route/function/resource coverage is checked against source during generation. Update the data-responsibility mapping whenever a table or bucket is added. Each view lists the implementation and runbooks used to verify its relationships.", ""]
    (ROOT / "ops/ARCHITECTURE.md").write_text("\n".join(docs))
    readme = (ROOT / "README.md").read_text()
    start = readme.index("## High-level AWS architecture")
    end = readme.index("## Current production topology")
    replacement = """## High-level AWS architecture

Start with this four-lane overview. Each lane reads left to right; numbered references lead to the detailed [website architecture atlas](ops/ARCHITECTURE.md). Solid arrows show requests/data; dashed arrows show control and operational work. Repeated names refer to the same system.

```mermaid
""" + diagrams[0] + """```

The [editable Miro board](""" + BOARD + """) and [Mermaid atlas](ops/ARCHITECTURE.md) share twelve focused views:

| Website and request flow | Media and state | Integrations and operations |
|---|---|---|
| 00 System overview | 04 Uploads, previews, video, heroes | 08 Camera-original comparisons |
| 01 Pages and visitor journeys | 05 Consistency and background work | 09 Admin and integrations |
| 02 Edge, identity, authorization | 06 Sharing, downloads, prints | 10 Build, release and ownership |
| 03 Catalog, indexes, data ownership | 07 Browser-only editor | 11 Observability, security, recovery |

The [complete source inventory](ops/ARCHITECTURE_INVENTORY.md) covers every page, API mapping, application Lambda, table/bucket and explicit infrastructure resource. The diagrams describe checked-in implementation and documented topology; conditional infrastructure is labeled and is not proof of live deployment.

Key boundaries: browser API calls use same-origin `/api`; large uploads use direct S3 capabilities; protected media uses authorized short-lived URLs. The local editor processes files in the browser. Gallery Before previews come from a separate private bucket. Fotomoto receives an opaque preview; print-ready files are uploaded manually after an order. The cross-Region recovery vault is a destination only—the checked-in primary backup plan does not schedule cross-Region copies.

"""
    (ROOT / "README.md").write_text(readme[:start] + replacement + readme[end:])
    if args.miro_dir:
        args.miro_dir.mkdir(parents=True, exist_ok=True)
        for i, v in enumerate(VIEWS):
            (args.miro_dir / (v["slug"] + ".dsl")).write_text(miro_dsl(v, i))
        (args.miro_dir / "manifest.json").write_text(json.dumps([dict(slug=v["slug"], title=v["title"]) for v in VIEWS], indent=2))
    print(json.dumps({"views": len(VIEWS), **counts}, indent=2))


if __name__ == "__main__":
    main()
