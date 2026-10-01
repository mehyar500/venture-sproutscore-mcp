#!/usr/bin/env python3
"""Deploy the sproutscore-mcp Worker via the Cloudflare v4 API.

Steps:
  1. PUT /accounts/{id}/workers/scripts/sproutscore-mcp  (multipart module upload)
  2. PATCH .../subdomain {"enabled": true}               (workers.dev URL)
  3. POST /accounts/{id}/workers/domains                 (mcp.sproutscore.mehyar.us)

Auth: stored custom.cloudflare credential via authd surrogate
(same pattern as ~/workspace/skills/cloudflare/bin/cf.py).
Usage: python3 deploy.py
"""
import io
import json
import os
import sys
import urllib.request
import urllib.error

sys.path.insert(0, "/opt/hatch/skills/skill-creator/bin")
import dynamic_credentials as dc

BASE = "https://api.cloudflare.com/client/v4"
CRED = "custom.cloudflare"
HOSTS = ["api.cloudflare.com"]
SCRIPT = "sproutscore-mcp"
CUSTOM_HOST = "mcp.sproutscore.mehyar.us"
HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "src")


def load_email():
    with open(os.path.expanduser("~/workspace/skills/cloudflare/config.json")) as f:
        return json.load(f)["email"].strip()


def api(path, method="GET", body=None, content_type="application/json"):
    req = urllib.request.Request(BASE + path, method=method,
                                 headers={"Accept": "application/json",
                                          "X-Auth-Email": load_email()})
    data = None
    if body is not None:
        if isinstance(body, str):
            body = body.encode()
        data = body
        req.add_header("Content-Type", content_type)
    dc.add_surrogate_to_request(req, CRED, allowed_hosts=HOSTS)
    try:
        with urllib.request.urlopen(req, data=data, timeout=120) as r:
            return r.status, dc.read_json_response(r)
    except urllib.error.HTTPError as e:
        raw = e.read(5000).decode("utf-8", "replace")
        try:
            return e.code, json.loads(raw)
        except ValueError:
            return e.code, {"http_error": e.code, "body": raw}


def multipart(parts):
    """parts: list of (name, filename, content_type, bytes). Returns (content_type, body)."""
    boundary = "----sproutscore" + os.urandom(8).hex()
    buf = io.BytesIO()
    for name, filename, ctype, data in parts:
        buf.write(f"--{boundary}\r\n".encode())
        disp = f'form-data; name="{name}"'
        if filename:
            disp += f'; filename="{filename}"'
        buf.write(f"Content-Disposition: {disp}\r\n".encode())
        buf.write(f"Content-Type: {ctype}\r\n\r\n".encode())
        buf.write(data)
        buf.write(b"\r\n")
    buf.write(f"--{boundary}--\r\n".encode())
    return f"multipart/form-data; boundary={boundary}", buf.getvalue()


def read_src(name):
    with open(os.path.join(SRC, name), "rb") as f:
        return f.read()


def main():
    st, accounts = api("/accounts")
    assert st == 200 and accounts.get("success"), accounts
    account = accounts["result"][0]["id"]
    print("account:", account)

    metadata = json.dumps({
        "main_module": "worker.js",
        "compatibility_date": "2026-09-30",
    })
    ctype, body = multipart([
        ("metadata", None, "application/json", metadata.encode()),
        ("worker.js", "worker.js", "application/javascript+module", read_src("worker.js")),
        ("data.js", "data.js", "application/javascript+module", read_src("data.js")),
        ("codes.js", "codes.js", "application/javascript+module", read_src("codes.js")),
    ])
    print("upload bundle: %.1f KB" % (len(body) / 1024,))
    st, res = api(f"/accounts/{account}/workers/scripts/{SCRIPT}", "PUT", body, ctype)
    print("upload:", st, json.dumps(res)[:500])
    assert st == 200 and res.get("success"), res

    st, res = api(f"/accounts/{account}/workers/scripts/{SCRIPT}/subdomain",
                  "PATCH", json.dumps({"enabled": True}))
    print("subdomain:", st, json.dumps(res)[:300])

    st, res = api(f"/accounts/{account}/workers/domains", "POST",
                  json.dumps({"hostname": CUSTOM_HOST, "service": SCRIPT}))
    ok = res.get("success") is True
    print("custom domain:", st, "success" if ok else json.dumps(res)[:500])

    st, res = api(f"/accounts/{account}/workers/scripts/{SCRIPT}")
    if st == 200 and res.get("success"):
        print("script id:", res["result"].get("id"), "modified:",
              res["result"].get("modified_on"))


if __name__ == "__main__":
    main()
