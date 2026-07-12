# NPU で embedding サーバを建てる（プラットフォーム別手順）

[setup.md「NPU で建てるのがおすすめ」](./setup.md#npu-で建てるのがおすすめ)の具体手順です。graphrag の埋め込みを、普段ほとんど遊んでいる NPU に常駐で任せ、CPU / GPU を開発作業と LLM に空けます。

| プラットフォーム | 方式 | 状態 |
|---|---|---|
| [Ubuntu (Intel NPU)](#ubuntu-intel-npu) | OpenVINO + 自作 FastAPI サーバ + systemd | **実機検証済み**（Core Ultra 7 165H / Ubuntu 22.04） |
| Windows (Intel NPU) | — | 動作実績あり。手順書は未整備（そのマシンで作業する時に追記） |
| macOS (Apple Silicon) | — | 動作実績あり。手順書は未整備（そのマシンで作業する時に追記） |

---

## 建てるものの姿（全プラットフォーム共通）

graphrag から見えるのは OpenAI 互換エンドポイント 1 つです。どのプラットフォームでも、次を満たす常駐サーバを建てれば接続できます:

- `POST /v1/embeddings` — OpenAI 互換の埋め込み応答
- `GET /v1/models` — `nomic-embed-text` を含むモデル一覧。**graphrag は endpoint を明示されるとまずここを叩き、目的のモデルを提供しているか検証します。** `/v1/models` の無いサーバは採用されません
- ポートは **19436** に統一します（Ollama 11434 / LM Studio 1234 の自動検出と衝突しない任意の番号。全マシンで同じにしておくと `~/.graphrag/.env` の内容がそのまま使い回せます）

接続設定はマシンごとの値なので `~/.graphrag/.env` に書きます:

```sh
# ~/.graphrag/.env
GRAPHRAG_EMBEDDING_ENDPOINT=http://localhost:19436/v1
```

`…/v1` でも `…/v1/embeddings` でも同じに解釈されます（末尾の `/embeddings` は剥がして正規化されます）。モデルは既定の `nomic-embed-text` のままなので `GRAPHRAG_EMBEDDING_MODEL` の指定は不要です。

なお `search_document:` / `search_query:` の非対称接頭辞は **graphrag 側が索引メタに従って付けます**。サーバ側は素のテキストを埋め込むだけでよく、接頭辞まわりの実装・設定は要りません。

### 乗り換え時は索引の作り直しが必須

すでに Ollama などで索引を作ったプロジェクトがある場合、**vault ごとにベクトル索引を作り直してください**。理由は 2 つ:

1. **索引はビルド時の endpoint を記録し、検索時もその記録どおりの endpoint に埋め込みを頼みます。** 旧 endpoint（例: Ollama の 11434）を止めると、その索引での検索は「recorded endpoint unreachable」と明示的に失敗します。
2. モデル名が同じ `nomic-embed-text` でも、ランタイムが違えば（Ollama の GGUF 量子化 → OpenVINO の fp16 など）出るベクトルは微妙に別物です。索引側と検索側で混ぜると精度が静かに落ちます。

作り直しは、各プロジェクトで書き込み（typed-add / commit-mutation / carve）が走っていないことを確認して:

```sh
rm -rf .graphrag/cache   # 索引は次の検索時に新しい endpoint で自動再構築される
```

---

## Ubuntu (Intel NPU)

Intel Core Ultra（Meteor Lake 以降）の NPU（AI Boost）を OpenVINO で使います。`nomic-embed-text-v1.5` の ONNX を OpenVINO IR に変換し、約 130 行の FastAPI サーバで OpenAI 互換に見せ、systemd で常駐させます。

検証済み構成（実機）:

| 項目 | 値 |
|---|---|
| CPU | Intel Core Ultra 7 165H（Meteor Lake） |
| OS / kernel | Ubuntu 22.04 LTS / 6.8.0（`intel_vpu` は kernel 6.8+ に同梱） |
| NPU ドライバ | intel-level-zero-npu 1.26.0 / level-zero 1.24.2 |
| Python | 3.10 / openvino 2026.2.1 / transformers 5.0.0 / fastapi 0.138.0 / uvicorn 0.49.0 |

参考実測（同一機、1 リクエストあたり）:

| デバイス | レイテンシ | GPU VRAM 消費 |
|---|---|---|
| NPU | 約 83〜140ms | 0 MB |
| CPU | 約 253ms | 0 MB |
| GPU（Ollama） | 約 23ms | 323 MB |

GPU の方が速いですが、NPU は **VRAM を一切食わず低消費電力**で、建てっぱなしの常駐用途に向きます。graphrag の埋め込みは 1 回の検索・書き込みで数件〜数十件なので、この速度で十分です。

以下、作業ディレクトリを `~/npu-embedding` として書きます（置き場所は任意）。

### 1. ハードウェアとカーネルの確認

```sh
lspci | grep -i npu        # → "Meteor Lake NPU" などが出ること
uname -r                   # → 6.8 以上であること
lsmod | grep intel_vpu     # → カーネルドライバがロード済みであること
```

kernel が 6.8 未満の Ubuntu 22.04 は HWE カーネルを入れます: `sudo apt install linux-generic-hwe-22.04`

### 2. NPU ユーザースペースドライバの導入

カーネルドライバ（`intel_vpu`）は同梱されていますが、OpenVINO から NPU を見せるにはユーザースペースドライバが別途要ります。[intel/linux-npu-driver の Releases](https://github.com/intel/linux-npu-driver/releases) から、自分の Ubuntu バージョン向けの `.deb` を 4 点ダウンロードして入れます:

- `intel-driver-compiler-npu`
- `intel-fw-npu`
- `intel-level-zero-npu`
- `level-zero`（リリースに同梱。無ければ [oneapi-src/level-zero の Releases](https://github.com/oneapi-src/level-zero/releases) から）

```sh
cd <ダウンロードしたディレクトリ>
sudo apt install ./intel-*.deb ./level-zero*.deb
```

検証済みバージョンは intel 側 1.26.0 / level-zero 1.24.2 です。

### 3. デバイス権限（render グループ）

NPU のデバイスノードは `render` グループのみ読み書きできます:

```sh
ls -l /dev/accel/accel0    # → crw-rw---- root render
sudo usermod -aG render $USER
```

グループ追加は**ログインし直すまで反映されません**。反映後、`groups` に `render` が出ることを確認してください。

### 4. Python 依存の導入

Python 3.10+ が必要です。`--user` で入れます（後述の systemd ユニットはこの前提です）:

```sh
pip install --user "openvino>=2025.2" transformers fastapi "uvicorn[standard]" huggingface_hub
```

### 5. モデルの取得と OpenVINO IR への変換

`nomic-embed-text-v1.5` の ONNX（fp16）を Hugging Face から取得し、OpenVINO IR に変換します。

```sh
mkdir -p ~/npu-embedding && cd ~/npu-embedding

# 5a. ONNX モデルとトークナイザの取得
python3 - << 'EOF'
from huggingface_hub import hf_hub_download
for f in ['onnx/model_fp16.onnx', 'tokenizer.json', 'tokenizer_config.json', 'special_tokens_map.json', 'config.json']:
    print(f'  Downloading {f}...')
    hf_hub_download('nomic-ai/nomic-embed-text-v1.5', f, local_dir='models/nomic-embed-onnx')
print('  Done.')
EOF

# 5b. OpenVINO IR へ変換 — NPU は動的 shape を受け付けないため [1, 512] の静的 shape に固定する（ここが肝）
python3 - << 'EOF'
import os
import openvino as ov
core = ov.Core()
model = core.read_model('models/nomic-embed-onnx/onnx/model_fp16.onnx')
model.reshape({'input_ids': [1, 512], 'attention_mask': [1, 512], 'token_type_ids': [1, 512]})
os.makedirs('models/nomic-embed-ov', exist_ok=True)
ov.save_model(model, 'models/nomic-embed-ov/model.xml')
print('  Saved OpenVINO IR to models/nomic-embed-ov/')
EOF
cp models/nomic-embed-onnx/{config.json,tokenizer.json,tokenizer_config.json,special_tokens_map.json} models/nomic-embed-ov/

# 5c. OpenVINO から NPU が見えることの確認
python3 -c "
import openvino as ov
devs = ov.Core().available_devices
print(f'Available devices: {devs}')
assert 'NPU' in devs, 'NPU not found! ドライバ導入(手順2)と render グループ(手順3)を確認'
print('NPU OK.')
"
```

静的 shape [1, 512] の帰結として、**512 トークンを超える入力は切り詰められます**。graphrag が埋め込むのはノードの summary / description 程度の短文なので、実用上は十分です。

### 6. サーバ本体（server.py）

`~/npu-embedding/server.py` として保存します:

```python
#!/usr/bin/env python3
"""OpenAI-compatible /v1/embeddings server running nomic-embed-text on Intel NPU."""

import argparse
import logging
import time
import os

import numpy as np
import openvino as ov
from transformers import AutoTokenizer
from fastapi import FastAPI
from fastapi.responses import JSONResponse
import uvicorn

logger = logging.getLogger("npu-embedding")

DEFAULT_MODEL_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "models", "nomic-embed-ov")
MAX_SEQ_LEN = 512
MODEL_NAME = "nomic-embed-text"

app = FastAPI()

tokenizer = None
compiled_model = None
device_name = None


def mean_pooling(last_hidden_state: np.ndarray, attention_mask: np.ndarray) -> np.ndarray:
    mask_expanded = attention_mask[:, :, np.newaxis].astype(np.float32)
    sum_embeddings = np.sum(last_hidden_state * mask_expanded, axis=1)
    sum_mask = np.clip(np.sum(mask_expanded, axis=1), a_min=1e-9, a_max=None)
    return sum_embeddings / sum_mask


def normalize(v: np.ndarray) -> np.ndarray:
    norms = np.linalg.norm(v, axis=1, keepdims=True)
    return v / np.clip(norms, a_min=1e-9, a_max=None)


def embed(texts: list[str]) -> list[list[float]]:
    results = []
    for text in texts:
        enc = tokenizer(
            text,
            padding="max_length",
            truncation=True,
            max_length=MAX_SEQ_LEN,
            return_tensors="np",
        )
        out = compiled_model({
            "input_ids": enc["input_ids"].astype(np.int64),
            "attention_mask": enc["attention_mask"].astype(np.int64),
            "token_type_ids": enc.get("token_type_ids", np.zeros_like(enc["input_ids"])).astype(np.int64),
        })
        hidden = out[compiled_model.output(0)]
        pooled = mean_pooling(hidden, enc["attention_mask"].astype(np.float32))
        normed = normalize(pooled)
        results.append(normed[0].tolist())
    return results


@app.post("/v1/embeddings")
async def create_embeddings(request: dict):
    inp = request.get("input", "")
    if isinstance(inp, str):
        texts = [inp]
    elif isinstance(inp, list):
        texts = [t if isinstance(t, str) else str(t) for t in inp]
    else:
        return JSONResponse(status_code=400, content={"error": "input must be string or array"})

    t0 = time.perf_counter()
    vectors = embed(texts)
    elapsed_ms = (time.perf_counter() - t0) * 1000

    logger.info(f"Embedded {len(texts)} text(s) in {elapsed_ms:.0f}ms on {device_name}")

    data = [
        {"object": "embedding", "index": i, "embedding": v}
        for i, v in enumerate(vectors)
    ]
    return {
        "object": "list",
        "data": data,
        "model": request.get("model", MODEL_NAME),
        "usage": {"prompt_tokens": 0, "total_tokens": 0},
    }


@app.get("/v1/models")
async def list_models():
    return {
        "object": "list",
        "data": [{"id": MODEL_NAME, "object": "model", "owned_by": "local"}],
    }


@app.get("/health")
async def health():
    return {"status": "ok", "device": device_name}


def main():
    global tokenizer, compiled_model, device_name

    parser = argparse.ArgumentParser(description="NPU Embedding Server")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=19436)
    parser.add_argument("--device", default="NPU", help="OpenVINO device: NPU, CPU, GPU")
    parser.add_argument("--model-dir", default=DEFAULT_MODEL_DIR)
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
    device_name = args.device
    model_dir = os.path.abspath(args.model_dir)

    logger.info(f"Loading tokenizer from {model_dir}")
    tokenizer = AutoTokenizer.from_pretrained(model_dir, trust_remote_code=True)

    logger.info(f"Loading OpenVINO model on {device_name}")
    core = ov.Core()
    model = core.read_model(os.path.join(model_dir, "model.xml"))
    compiled_model = core.compile_model(model, device_name)
    logger.info(f"Model compiled on {device_name}, ready to serve on :{args.port}")

    uvicorn.run(app, host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
```

既定で 127.0.0.1 にのみ bind します（他マシンへは公開しない）。別マシンから使わせたい場合のみ `--host 0.0.0.0` を付け、クライアント側の `GRAPHRAG_EMBEDDING_ENDPOINT` をそのマシンの IP にします。

### 7. 動作確認（フォアグラウンド）

```sh
cd ~/npu-embedding
python3 server.py --device NPU --model-dir models/nomic-embed-ov --port 19436
```

別ターミナルで:

```sh
curl -s http://127.0.0.1:19436/health
# → {"status":"ok","device":"NPU"}

curl -s http://127.0.0.1:19436/v1/models
# → {"object":"list","data":[{"id":"nomic-embed-text","object":"model","owned_by":"local"}]}

curl -s http://127.0.0.1:19436/v1/embeddings \
  -H "Content-Type: application/json" \
  -d '{"input": "hello world", "model": "nomic-embed-text"}' | head -c 200
# → {"object":"list","data":[{"object":"embedding","index":0,"embedding":[0.0123, ... 768 次元
```

### 8. systemd で常駐化

`~/npu-embedding/npu-embedding.service` を作ります。`<you>` は自分のユーザー名に、`PYTHONPATH` は `python3 -c 'import site; print(site.getusersitepackages())'` の出力に置き換えてください:

```ini
[Unit]
Description=NPU Embedding Server (nomic-embed-text on Intel AI Boost)
After=network-online.target

[Service]
ExecStart=/usr/bin/python3 /home/<you>/npu-embedding/server.py --device NPU --model-dir /home/<you>/npu-embedding/models/nomic-embed-ov --port 19436
User=<you>
Group=<you>
Restart=always
RestartSec=3
# pip install --user の site-packages を systemd 起動の python3 に見せる
Environment="PYTHONPATH=/home/<you>/.local/lib/python3.10/site-packages"

[Install]
WantedBy=default.target
```

インストールと起動:

```sh
sudo cp ~/npu-embedding/npu-embedding.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now npu-embedding

systemctl status npu-embedding          # active (running) を確認
curl -s http://127.0.0.1:19436/health   # → {"status":"ok","device":"NPU"}
journalctl -u npu-embedding -f          # 1 件ごとの処理時間がログに出る
```

### 9. graphrag との接続

```sh
mkdir -p ~/.graphrag
echo 'GRAPHRAG_EMBEDDING_ENDPOINT=http://localhost:19436/v1' >> ~/.graphrag/.env
```

既存プロジェクトを Ollama などから乗り換える場合は、[乗り換え時は索引の作り直しが必須](#乗り換え時は索引の作り直しが必須) を実施します。最後にどれかのプロジェクトで `ask` を 1 回叩き、検索が通ること（および `journalctl` にリクエストが流れること）を確認すれば完了です。

### トラブルシュート

| 症状 | 見るところ |
|---|---|
| `available_devices` に NPU が出ない | ドライバ 4 点が入っているか（`dpkg -l \| grep -E "npu\|level-zero"`）。`dmesg \| grep -i vpu` でファームウェアロード失敗が出ていないか。ドライバ導入後は再起動 |
| `/dev/accel/accel0` で Permission denied | `render` グループに入っているか（`groups`）。追加後にログインし直したか |
| IR 変換や NPU コンパイルで失敗 | 手順 5b の静的 shape 指定（NPU は動的 shape 不可）。openvino のバージョン（`>=2025.2`） |
| graphrag が「does not serve model」で失敗 | `curl http://127.0.0.1:19436/v1/models` の応答に `nomic-embed-text` が入っているか |
| systemd で `ModuleNotFoundError` | ユニットの `PYTHONPATH` が `python3 -c 'import site; print(site.getusersitepackages())'` の出力と一致しているか |

---

## Windows (Intel NPU)

動作実績はありますが、手順書はまだ起こせていません。そのマシンで作業する時に、Ubuntu 手順と同じ骨格（OpenVINO は Windows の Intel NPU にも対応。OpenAI 互換サーバ + 常駐化 + `~/.graphrag/.env`、ポート 19436）で追記してください。

## macOS (Apple Silicon)

動作実績はありますが、手順書はまだ起こせていません。そのマシンで作業する時に、共通の要件（`/v1/embeddings` + `/v1/models`、ポート 19436、`~/.graphrag/.env`）に合わせて追記してください。

---

## 関連

- [セットアップマニュアル](./setup.md) — embedding サーバ / `.env` / `VAULT.md` の設定詳細（NPU を推す理由は §embedding サーバ）
- [プラグイン README](../README.md)
