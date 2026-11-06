# Альтернатива Blueprint'у: docker build -t bioglow-sim . && docker run -p 8080:8080 bioglow-sim
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PORT=8080 \
    LOG_LEVEL=info

WORKDIR /app
COPY server.py ./
COPY public ./public

# без root
RUN useradd --create-home --uid 10001 app
USER app

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD python -c "import os,urllib.request; urllib.request.urlopen('http://127.0.0.1:%s/healthz' % os.environ.get('PORT', '8080'), timeout=4)"

# SIGTERM -> сервер закрывает WebSocket с кодом 1001 и выходит
STOPSIGNAL SIGTERM
CMD ["python", "server.py"]
