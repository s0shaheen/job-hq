# Shared foundation for Job Search HQ: schema, durable sheet access, job keys,
# notifications, config, LLM helpers. Every subsystem (monitor/, tracker/)
# builds on this package — nothing above it may address the spreadsheet
# positionally or bypass the verified-write path.
