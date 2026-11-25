package app.relaydesk.lan;

import android.app.Service;
import android.content.Intent;
import android.os.Binder;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import org.json.JSONException;
import org.json.JSONObject;

public final class ConversationService extends Service implements Link.Observer {
    private final Handler main = new Handler(Looper.getMainLooper());
    private final IBinder binder = new LocalBinder();
    private final LinkedHashMap<String, String> transcript = new LinkedHashMap<>();
    private Runnable observer;
    private Link link;
    private boolean connected;
    private String status = "";
    private String conversation = "";

    final class LocalBinder extends Binder {
        ConversationService service() {
            return ConversationService.this;
        }
    }

    @Override public void onCreate() {
        super.onCreate();
        status = getString(R.string.connect_hint);
    }

    @Override public IBinder onBind(Intent intent) {
        return binder;
    }

    void attach(Runnable listener) {
        observer = listener;
        changed();
    }

    void detach(Runnable listener) {
        if (observer == listener) {
            observer = null;
        }
    }

    boolean hasLink() { return link != null; }
    boolean isConnected() { return connected; }
    String getStatus() { return status; }
    String getConversation() { return conversation; }
    java.util.Map<String, String> getMessages() { return transcript; }

    private void changed() {
        if (observer != null) {
            observer.run();
        }
    }

    void setStatus(int message) {
        setStatus(getString(message));
    }

    private void setStatus(String message) {
        status = message;
        changed();
    }

    void connect(String code) {
        if (link != null) {
            disconnect(R.string.disconnected);
            return;
        }
        try {
            link = new Link(code, this);
        } catch (IllegalArgumentException error) {
            setStatus(R.string.pair_error);
            return;
        }
        transcript.clear();
        conversation = "";
        setStatus(R.string.connecting);
        link.start();
    }

    boolean sendText(String text) {
        if (!connected || text.isEmpty()) {
            return false;
        }
        byte[] payload = text.getBytes(StandardCharsets.UTF_8);
        if (payload.length > 8192) {
            setStatus(R.string.message_too_long);
            return false;
        }
        return link.send(Link.TEXT, payload);
    }

    @Override public void event(Link source, int kind, byte[] payload) throws IOException {
        if (kind != Link.READY && kind != Link.MESSAGE && kind != Link.ERROR) return;
        final JSONObject value;
        try { value = new JSONObject(new String(payload, StandardCharsets.UTF_8)); }
        catch (JSONException error) { throw new IOException("Invalid message frame", error); }
        main.post(() -> {
            if (link == source) {
                receive(kind, value);
            }
        });
    }

    private void receive(int kind, JSONObject value) {
        switch (kind) {
            case Link.READY:
                connected = true;
                conversation = value.optString("name");
                setStatus(R.string.connected);
                break;
            case Link.MESSAGE:
                String id = value.optString("id"), text = value.optString("text");
                String speaker = "user".equals(value.optString("type")) ? getString(R.string.you) :
                    value.optString("roleName", getString(R.string.assistant));
                if (!id.isEmpty() && !text.isEmpty()) {
                    transcript.put(id, speaker + "\n" + text);
                    if (transcript.size() > 100) transcript.remove(transcript.keySet().iterator().next());
                }
                changed();
                break;
            case Link.ERROR:
                setStatus(value.optString("message", getString(R.string.phone_error)));
                break;
            default:
                break;
        }
    }

    @Override public void closed(Link source) {
        main.post(() -> {
            if (link == source) {
                disconnect(R.string.connect_error);
            }
        });
    }

    private void disconnect(int reason) {
        closeSession();
        setStatus(reason);
    }

    private void closeSession() {
        Link previous = link;
        link = null;
        if (previous != null) {
            previous.close();
        }
        connected = false;
    }

    @Override public void onDestroy() {
        observer = null;
        closeSession();
        super.onDestroy();
    }

}
