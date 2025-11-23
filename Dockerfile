FROM python:3.13-slim

WORKDIR /app

ADD src ./src
ADD pyproject.toml .
ADD setup.py .

# Install uv (replaces pip)
RUN pip install uv

# Install your package using uv
RUN uv pip install --system . --no-cache

EXPOSE 8000

ENTRYPOINT ["sh", "-c", \
    "panel serve src/zombie/app.py src/zombie/assets.py \
        --static-dirs images=src/zombie/images \
        --address 0.0.0.0 \
        --port 8000 \
        --allow-websocket-origin ${ALLOW_WEBSOCKET_ORIGIN} \
        --oauth-redirect-uri ${OAUTH_REDIRECT} \
        --keep-alive 10000 \
        --index=app \
        --num-threads $(nproc)"]
