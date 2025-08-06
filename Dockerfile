# Use the official Deno image
FROM denoland/deno

ENV TINI_SUBREAPER=1

RUN install --owner=deno --group=deno /dev/null /memory.json && \
    echo '{}' >/memory.json

USER deno


# Copy the source code
COPY bot.ts ./

RUN deno cache bot.ts

# Run the bot with the required permissions
CMD ["run", "--allow-net", "--allow-read", "--allow-write", "--allow-env", "bot.ts"]
