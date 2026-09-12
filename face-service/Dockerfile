FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 \
    libglib2.0-0 \
    wget \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.lock .
RUN pip install --no-cache-dir --require-hashes --only-binary=:all: -r requirements.lock

# Download InsightFace buffalo_s models during build (~16MB total).
# Pinned to HuggingFace commit 0ff1751885575e62e084dff70549ce24a11fa5dc with
# SHA-256 digests; the build fails if upstream content drifts. The same commit
# and digests are declared in model_pinning.py (runtime re-verification) and
# ../pi-kiosk/model_pinning.py (the kiosk must embed with the identical model).
# To re-pin: resolve the new commit, download both files, sha256sum them, then
# update all three places together (see model_pinning.py for the commands).
RUN mkdir -p /app/models && \
    wget -q "https://huggingface.co/immich-app/buffalo_s/resolve/0ff1751885575e62e084dff70549ce24a11fa5dc/detection/model.onnx" \
      -O /app/models/det_model.onnx && \
    wget -q "https://huggingface.co/immich-app/buffalo_s/resolve/0ff1751885575e62e084dff70549ce24a11fa5dc/recognition/model.onnx" \
      -O /app/models/rec_model.onnx && \
    echo "5e4447f50245bbd7966bd6c0fa52938c61474a04ec7def48753668a9d8b4ea3a  /app/models/det_model.onnx" | sha256sum -c && \
    echo "9cc6e4a75f0e2bf0b1aed94578f144d15175f357bdc05e815e5c4a02b319eb4f  /app/models/rec_model.onnx" | sha256sum -c && \
    ls -la /app/models/

COPY model_pinning.py ./
COPY main.py face_auth.py ./

EXPOSE 5557

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "5557"]
