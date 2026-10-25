# Adds a dapp's screens to wedgie.dev/clear (public/clear/index.html reads public/clear/screens/index.json).
#   python3 tools/clear_page.py <slug> "<title>" <txs.json> <shots dir> "<note>"
# txs.json: tools/clear_txs.py's output; shots dir: safechip --shots (<case>-<n>.png, n=1 the "Reading" splash, skipped).
# Run again with the same slug to replace that section.
import json, os, re, shutil, sys

slug, title, txs, shots, note = sys.argv[1:6]
root = os.path.join(os.path.dirname(__file__), "..", "public", "clear", "screens")
out = os.path.join(root, slug)
shutil.rmtree(out, ignore_errors=True)
os.makedirs(out)
cases = []
for i, t in enumerate(json.load(open(txs))):
    base = re.sub(r"[^a-z0-9]+", "-", t["name"], flags=re.I)[:60]
    pages = []
    n = 2
    while os.path.exists(os.path.join(shots, "%s-%d.png" % (base, n))):
        f = "%02d-%d.png" % (i + 1, n - 1)
        shutil.copy(os.path.join(shots, "%s-%d.png" % (base, n)), os.path.join(out, f))
        pages.append("screens/%s/%s" % (slug, f))
        n += 1
    if pages:
        cases.append({"name": re.sub(r" - chain \d+$", "", t["name"]), "chainId": t["chainId"], "to": t["to"],
                      "pages": pages})
idx = os.path.join(root, "index.json")
sections = [s for s in (json.load(open(idx)) if os.path.exists(idx) else []) if s["slug"] != slug]
sections.append({"slug": slug, "title": title, "note": note, "cases": cases})
json.dump(sections, open(idx, "w"), indent=1)
print("%s: %d transactions, %d screens" % (slug, len(cases), sum(len(c["pages"]) for c in cases)))
