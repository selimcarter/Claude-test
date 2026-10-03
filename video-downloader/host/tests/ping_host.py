"""Test de fumee : lance l'hote natif, envoie PING et verifie la reponse PONG.

Usage : python ping_host.py <commande de l'hote...>
"""
import json
import struct
import subprocess
import sys

process = subprocess.Popen(sys.argv[1:], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
payload = json.dumps({"type": "PING", "requestId": "smoke"}).encode()
process.stdin.write(struct.pack("<I", len(payload)) + payload)
process.stdin.flush()
length = struct.unpack("<I", process.stdout.read(4))[0]
response = json.loads(process.stdout.read(length))
process.stdin.close()
process.wait(timeout=30)
print(response)
assert response["type"] == "PONG" and response["requestId"] == "smoke", response
