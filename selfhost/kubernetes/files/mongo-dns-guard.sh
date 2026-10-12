#!/bin/sh
set -eu
: "${POD_IP:?missing pod IP}"
: "${MEMBER_DNS:?missing member DNS}"
: "${DNS_GUARD_SECONDS:=300}"
case "$DNS_GUARD_SECONDS" in ''|*[!0-9]*) exit 2;; esac
case "$POD_IP" in *:*) family=ahostsv6;; *) family=ahostsv4;; esac
deadline=$(( $(date +%s) + DNS_GUARD_SECONDS ))
matched=0
while [ "$(date +%s)" -lt "$deadline" ]; do
  addresses=$(timeout 5 getent "$family" "$MEMBER_DNS" 2>/dev/null | awk '{print $1}' | sort -u || true)
  if [ "$addresses" = "$POD_IP" ]; then
    matched=$((matched + 1))
    if [ "$matched" -ge 2 ]; then
      echo 'Mongo member DNS matches current pod IP'
      exit 0
    fi
  else
    matched=0
  fi
  sleep 1
done
echo 'Mongo member DNS did not converge before deadline' >&2
exit 1
