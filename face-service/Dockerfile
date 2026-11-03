FROM python:3.14-slim@sha256:a2b82f3c48559aa0a8446d9af49826b6e2b2016f4cd2afabfe6013ec53729170

ENV PYTHONDONTWRITEBYTECODE=1 \
    HOME=/home/face-service \
    XDG_CACHE_HOME=/home/face-service/.cache

RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 \
    libglib2.0-0 \
    wget \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.lock .
RUN pip install --no-cache-dir --require-hashes --only-binary=:all: -r requirements.lock

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

# The baked model is verified at runtime, never replaced by the service user.
# Keep code/model files root-owned; only HOME (caches) and /tmp are writable.
RUN groupadd --gid 10001 face-service && \
    useradd --uid 10001 --gid 10001 --create-home \
      --home-dir /home/face-service --shell /usr/sbin/nologin face-service && \
    chown -R root:root /app && \
    find /app -type d -exec chmod 0555 {} + && \
    find /app -type f -exec chmod 0444 {} +

USER 10001:10001

EXPOSE 5557

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "5557"]
