package app.relaydesk.lan;

import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.cert.CertificateException;
import java.security.cert.X509Certificate;
import java.util.concurrent.ArrayBlockingQueue;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;

final class Link {
    static final int AUTH = 1, LISTEN = 2, STOP = 3, MIC = 4, TEXT = 5, PLAYED = 6;
    static final int READY = 10, PHASE = 11, MESSAGE = 12, WAV = 14, ERROR = 16;
    private static final int MAX_REPLY = 16 * 1024 * 1024;

    interface Observer {
        void event(Link link, int kind, byte[] payload) throws IOException;
        void closed(Link link);
    }

    private static final class Frame {
        final int kind;
        final byte[] payload;

        Frame(int kind, byte[] payload) {
            this.kind = kind;
            this.payload = payload;
        }

        void write(DataOutputStream output) throws IOException {
            output.writeByte(kind);
            output.writeInt(payload.length);
            output.write(payload);
            output.flush();
        }
    }

    private final Observer observer;
    private final InetSocketAddress address;
    private final byte[] fingerprint;
    private final byte[] token;
    private final ArrayBlockingQueue<Frame> outgoing = new ArrayBlockingQueue<>(64);
    private final Socket transport = new Socket();
    private volatile Thread writer;
    private volatile boolean closed;

    Link(String code, Observer observer) {
        this.observer = observer;
        String[] fields = code.trim().split("/", -1);
        if (fields.length != 3 || !fields[0].matches("[0-9.]+:[0-9]{1,5}")
                || !fields[1].matches("[0-9a-fA-F]{64}") || !fields[2].matches("[0-9a-f]{32}")) {
            throw new IllegalArgumentException("Invalid pairing code");
        }
        String[] endpoint = fields[0].split(":");
        address = InetSocketAddress.createUnresolved(endpoint[0], Integer.parseInt(endpoint[1]));
        fingerprint = new byte[32];
        for (int i = 0; i < fingerprint.length; i++) {
            fingerprint[i] = (byte) Integer.parseInt(fields[1].substring(i * 2, i * 2 + 2), 16);
        }
        token = fields[2].getBytes(StandardCharsets.US_ASCII);
    }

    void start() {
        new Thread(this::read, "relay-desk-link").start();
    }

    void send(int kind) {
        send(kind, new byte[0]);
    }

    boolean send(int kind, byte[] payload) {
        if (closed) {
            return false;
        }
        if (!outgoing.offer(new Frame(kind, payload))) {
            close();
            return false;
        }
        return true;
    }

    void close() {
        closed = true;
        try {
            transport.close();
        } catch (IOException ignored) {
        }
        Thread sender = writer;
        if (sender != null) {
            sender.interrupt();
        }
    }

    private void read() {
        try {
            SSLContext tls = SSLContext.getInstance("TLS");
            tls.init(null, new TrustManager[]{new PinnedCertificate(fingerprint)}, null);
            transport.connect(new InetSocketAddress(address.getHostString(), address.getPort()), 5000);
            transport.setTcpNoDelay(true);
            transport.setSoTimeout(5000);
            try (SSLSocket secure = (SSLSocket) tls.getSocketFactory().createSocket(
                    transport, address.getHostString(), address.getPort(), true)) {
                secure.startHandshake();
                DataInputStream input = new DataInputStream(secure.getInputStream());
                DataOutputStream output = new DataOutputStream(secure.getOutputStream());
                new Frame(AUTH, token).write(output);
                while (!closed) {
                    int kind = input.readUnsignedByte();
                    int size = input.readInt();
                    if (size < 0 || size > (kind == WAV ? MAX_REPLY : 131072)) {
                        throw new IOException("Invalid frame length");
                    }
                    byte[] payload = new byte[size];
                    input.readFully(payload);
                    if (kind == READY) {
                        secure.setSoTimeout(0);
                        writer = new Thread(() -> write(output), "relay-desk-send");
                        writer.start();
                    }
                    observer.event(this, kind, payload);
                }
            }
        } catch (Exception ignored) {
            // A closed socket and a failed connection both return to the pairing screen.
        } finally {
            close();
            observer.closed(this);
        }
    }

    private void write(DataOutputStream output) {
        try {
            while (!closed) {
                outgoing.take().write(output);
            }
        } catch (IOException | InterruptedException error) {
            close();
        }
    }

    private static final class PinnedCertificate implements X509TrustManager {
        private final byte[] fingerprint;

        PinnedCertificate(byte[] fingerprint) {
            this.fingerprint = fingerprint;
        }

        @Override public void checkServerTrusted(X509Certificate[] chain, String type)
                throws CertificateException {
            if (chain == null || chain.length == 0) {
                throw new CertificateException("Missing server certificate");
            }
            try {
                chain[0].checkValidity();
                byte[] actual = MessageDigest.getInstance("SHA-256").digest(chain[0].getEncoded());
                if (!MessageDigest.isEqual(fingerprint, actual)) {
                    throw new CertificateException("Unexpected server certificate");
                }
            } catch (java.security.NoSuchAlgorithmException error) {
                throw new CertificateException(error);
            }
        }

        @Override public void checkClientTrusted(X509Certificate[] chain, String type)
                throws CertificateException {
            throw new CertificateException("Client certificates are not used");
        }

        @Override public X509Certificate[] getAcceptedIssuers() {
            return new X509Certificate[0];
        }
    }
}
