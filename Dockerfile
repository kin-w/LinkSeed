FROM python:3.13-slim-bookworm

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    TZ=Asia/Shanghai

WORKDIR /app

ARG TARGETARCH
ARG TARGETVARIANT

COPY requirements.txt /app/requirements.txt
RUN apt-get update \
 && apt-get install -y --no-install-recommends tzdata \
 && if [ "$TARGETARCH" = "arm" ] && [ "$TARGETVARIANT" = "v7" ]; then \
      apt-get install -y --no-install-recommends gcc libc6-dev; \
    fi \
 && pip install --no-cache-dir -r /app/requirements.txt \
 && if [ "$TARGETARCH" = "arm" ] && [ "$TARGETVARIANT" = "v7" ]; then \
      apt-get purge -y --auto-remove gcc libc6-dev; \
    fi \
 && rm -rf /var/lib/apt/lists/*

COPY app.py ed2k.py torrent.py /app/
COPY static /app/static

RUN mkdir -p /data/blobs /data/torrents /host

ENV ED2K_DATA=/data \
    ED2K_PORT=5566 \
    ED2K_ROOTS=/host \
    ED2K_HASH_WORKERS=2

VOLUME ["/data"]
EXPOSE 5566

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:5566/api/health', timeout=2)" || exit 1

CMD ["python3", "-u", "/app/app.py"]
