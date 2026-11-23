from datetime import datetime, timedelta, timezone
from ipaddress import IPv4Address
import json
from pathlib import Path
import sys


def identity(address):
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec

    key = ec.generate_private_key(ec.SECP256R1())
    now = datetime.now(timezone.utc)
    name = x509.Name([x509.NameAttribute(x509.NameOID.COMMON_NAME, 'ai-team LAN')])
    cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name)
            .public_key(key.public_key()).serial_number(x509.random_serial_number())
            .not_valid_before(now - timedelta(minutes=5)).not_valid_after(now + timedelta(days=1))
            .add_extension(x509.SubjectAlternativeName([x509.IPAddress(IPv4Address(address))]), critical=False)
            .sign(key, hashes.SHA256()))
    return {'cert': cert.public_bytes(serialization.Encoding.PEM).decode(),
            'key': key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                     serialization.NoEncryption()).decode(),
            'fingerprint': cert.fingerprint(hashes.SHA256()).hex()}


def main():
    runtime = Path(sys.argv[1])
    # Reuse pairing packages from existing installations when present.
    sys.path[:0] = [str(runtime / 'deps'), str(runtime.parent / 'voice' / 'deps')]
    command = sys.argv[2]
    if command == 'identity':
        print(json.dumps(identity(sys.argv[3])))
    elif command == 'qr':
        import qrcode
        code = sys.stdin.read(1024)
        qr = qrcode.QRCode(border=4)
        qr.add_data('relaydesk:' + code)
        print(json.dumps(qr.get_matrix()))


if __name__ == '__main__':
    main()
