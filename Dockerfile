# Use the official Deno image
FROM denoland/deno

# Copy the source code
COPY bot.ts ./

# Run the bot with the required permissions
CMD ["deno", "run", "--allow-net", "--allow-read", "--allow-write", "--allow-env", "bot.ts"]
