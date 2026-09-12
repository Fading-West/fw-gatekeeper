FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 \
    libglib2.0-0 \
    wget \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Download the InsightFace buffalo_s recognition model during build (~13MB).
# Pinned to HuggingFace commit 0ff1751885575e62e084dff70549ce24a11fa5dc with
# SHA-256 digests; the build fails if upstream content drifts. The same commit
# and digests are declared in model_pinning.py (runtime re-verification) and
# ../pi-kiosk/model_pinning.py (the kiosk must embed with the identical model).
# To re-pin: resolve the new commit, download both files, sha256sum them, then
# update all three places together (see model_pinning.py for the commands).
RUN mkdir -p /app/models && \
    wget -q "https://huggingface.co/immich-app/buffalo_s/resolve/0ff1751885575e62e084dff70549ce24a11fa5dc/recognition/model.onnx" \
      -O /app/models/rec_model.onnx && \
    echo "9cc6e4a75f0e2bf0b1aed94578f144d15175f357bdc05e815e5c4a02b319eb4f  /app/models/rec_model.onnx" | sha256sum -c && \
    ls -la /app/models/

COPY model_pinning.py ./
COPY main.py face_auth.py enrollment_quality.py ./

EXPOSE 5557

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "5557"]
