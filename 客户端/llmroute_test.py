"""llmroute 图片/视频生成测试。
用法: python llmroute_test.py image|video [model]
输入: test.py 第1行为视频密钥, 第2行为 Base URL, 第3行为图片密钥; 输出: 文件保存到 ./out/
"""
import base64, json, pathlib, sys, time
import requests

lines = pathlib.Path(__file__).with_name("test.py").read_text(encoding="utf-8").split()
BASE = lines[1].rstrip("/")
VIDEO_KEY, IMAGE_KEY = lines[0], lines[2]
H = {"Authorization": f"Bearer {VIDEO_KEY}"}
HI = {"Authorization": f"Bearer {IMAGE_KEY}"}
OUT = pathlib.Path(__file__).with_name("out")
OUT.mkdir(exist_ok=True)


def show(r):
    print(f"[HTTP {r.status_code}]", r.text[:800])


def image(model="gpt-image-2"):
    r = requests.post(f"{BASE}/v1/images/generations", headers=HI, timeout=600,
                      json={"model": model, "prompt": "一只戴墨镜的柴犬，插画风格", "size": "1024x1024", "n": 1})
    show(r)
    r.raise_for_status()
    item = r.json()["data"][0]
    path = OUT / "image.png"
    if item.get("b64_json"):
        path.write_bytes(base64.b64decode(item["b64_json"]))
    else:
        path.write_bytes(requests.get(item["url"], timeout=120).content)
    print("saved", path)


def video(model="minimax-h3-768p"):
    r = requests.post(f"{BASE}/v1/videos", headers=H, timeout=120,
                      json={"model": model, "prompt": "一只柴犬在海边冲浪", "seconds": 4})
    show(r)
    r.raise_for_status()
    tid = r.json()["id"]
    for _ in range(120):
        time.sleep(5)
        s = requests.get(f"{BASE}/v1/videos/{tid}", headers=H, timeout=60).json()
        print(s.get("status"), s.get("progress"))
        if s.get("status") == "completed":
            break
        if s.get("status") == "failed":
            sys.exit(f"failed: {json.dumps(s, ensure_ascii=False)}")
    else:
        sys.exit("timeout")
    c = requests.get(f"{BASE}/v1/videos/{tid}/content", headers=H, timeout=300)
    print("content HTTP", c.status_code, c.headers.get("content-type"))
    c.raise_for_status()
    path = OUT / "video.mp4"
    path.write_bytes(c.content)
    print("saved", path, len(c.content), "bytes")


if __name__ == "__main__":
    {"image": image, "video": video}[sys.argv[1]](*sys.argv[2:3])
