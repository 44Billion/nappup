"""Exercise the real CLI with a TTY that stays open after both answers."""
import os
import pty
import select
import subprocess
import sys
import time

master, slave = pty.openpty()
child = subprocess.Popen([sys.argv[1], sys.argv[2], 'env', 'set', 'NOSTR_SECRET_KEY'], stdin=slave, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
output = b''
secret = b'0' * 63 + b'7'
try:
    for prompt in [b'NOSTR_SECRET_KEY: ', b'Confirm NOSTR_SECRET_KEY: ']:
        deadline = time.monotonic() + 5
        while prompt not in output:
            if time.monotonic() > deadline:
                raise RuntimeError('CLI prompt timed out')
            if select.select([child.stdout], [], [], .1)[0]:
                output += os.read(child.stdout.fileno(), 4096)
        os.write(master, secret + b'\r')
    child.wait(timeout=5)
    output += child.stdout.read()
    assert child.returncode == 0
    assert b'Set encrypted NOSTR_SECRET_KEY' in output
    assert secret not in output
    print('TTY CLI saved the credential and exited without closing stdin')
finally:
    if child.poll() is None:
        child.kill()
        child.wait()
    os.close(master)
    os.close(slave)
