FROM postgres:16-alpine

RUN apk add --no-cache aws-cli bash tzdata

COPY backup.sh /usr/local/bin/backup-postgres
COPY restore-verify.sh /usr/local/bin/restore-verify
COPY crontab /etc/crontabs/root
RUN chmod 0755 /usr/local/bin/backup-postgres /usr/local/bin/restore-verify

CMD ["crond", "-f", "-l", "2"]
