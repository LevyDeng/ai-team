package app.relaydesk.lan;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaPlayer;
import android.media.MediaRecorder;
import android.os.Binder;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.text.TextUtils;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import org.json.JSONException;
import org.json.JSONObject;

public final class ConversationService extends Service implements Link.Observer {
    static final String START_AUTO = "app.relaydesk.lan.START_AUTO";
    private static final String STOP_SESSION = "app.relaydesk.lan.STOP_SESSION";
    private static final String CHANNEL = "voice_conversation";
    private static final int NOTIFICATION_ID = 1;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final IBinder binder = new LocalBinder();
    private final LinkedHashMap<String, String> transcript = new LinkedHashMap<>();
    private Runnable observer;
    private Link link;
    private Capture capture;
    private MediaPlayer player;
    private File audioFile;
    private PowerManager.WakeLock wakeLock;
    private boolean foreground;
    private boolean connected;
    private boolean automatic;
    private boolean working;
    private boolean inputAllowed;
    private String phase = "off";
    private String status = "";
    private String conversation = "";
    private byte[] playingSegment;

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

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? null : intent.getAction();
        if (STOP_SESSION.equals(action)) {
            disconnect(R.string.disconnected);
        } else if (START_AUTO.equals(action) && connected && inputAllowed && !working) {
            try {
                if (!foreground) {
                    showForegroundNotification();
                }
                automatic = true;
                link.send(Link.LISTEN);
                listen();
            } catch (RuntimeException error) {
                automatic = false;
                stopCapture();
                stopBackgroundSession();
                setStatus(R.string.background_error);
            }
        } else if (!foreground) {
            stopSelf(startId);
        }
        return START_NOT_STICKY;
    }

    private void showForegroundNotification() {
        Notification.Builder notification;
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel channel = new NotificationChannel(
                CHANNEL, getString(R.string.notification_channel), NotificationManager.IMPORTANCE_LOW);
            getSystemService(NotificationManager.class).createNotificationChannel(channel);
            notification = new Notification.Builder(this, CHANNEL);
        } else {
            notification = new Notification.Builder(this).setPriority(Notification.PRIORITY_LOW);
        }
        PendingIntent open = PendingIntent.getActivity(this, 0,
            new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE);
        PendingIntent stop = PendingIntent.getService(this, 1,
            new Intent(this, ConversationService.class).setAction(STOP_SESSION),
            PendingIntent.FLAG_IMMUTABLE);
        notification.setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setContentTitle(getString(R.string.app_name))
            .setContentText(getString(R.string.auto_background))
            .setContentIntent(open)
            .setOngoing(true)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .addAction(new Notification.Action.Builder(
                (android.graphics.drawable.Icon) null, getString(R.string.notification_stop), stop).build());
        if (Build.VERSION.SDK_INT >= 31) {
            notification.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE);
        }
        if (Build.VERSION.SDK_INT >= 29) {
            int types = ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK;
            if (Build.VERSION.SDK_INT >= 30) {
                types |= ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE;
            }
            startForeground(NOTIFICATION_ID, notification.build(), types);
        } else {
            startForeground(NOTIFICATION_ID, notification.build());
        }
        foreground = true;
        wakeLock = getSystemService(PowerManager.class)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "RelayDesk:conversation");
        wakeLock.setReferenceCounted(false);
        wakeLock.acquire();
    }

    private void stopBackgroundSession() {
        if (wakeLock != null) {
            if (wakeLock.isHeld()) {
                wakeLock.release();
            }
            wakeLock = null;
        }
        if (foreground) {
            stopForeground(STOP_FOREGROUND_REMOVE);
            foreground = false;
        }
        stopSelf();
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
    boolean isAutomatic() { return automatic; }
    boolean isInputAllowed() { return inputAllowed; }
    boolean isWorking() { return working; }
    String getStatus() { return status; }
    String getTranscript() { return (conversation.isEmpty() ? "" : conversation + "\n\n") + TextUtils.join("\n\n", transcript.values()); }

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

    void stopAuto() {
        automatic = false;
        stopCapture();
        link.send(Link.STOP);
        stopBackgroundSession();
        if (!working) setStatus(R.string.connected);
        else changed();
    }

    private void listen() {
        if (!connected || !automatic || !inputAllowed || !"listening".equals(phase) || capture != null) {
            return;
        }
        setStatus(R.string.listening);
        capture = new Capture(link);
        capture.start();
    }

    private void stopCapture() {
        if (capture != null) {
            capture.interrupt();
            capture = null;
        }
    }

    boolean sendText(String text) {
        if (!connected || automatic || working || text.isEmpty()) {
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
        if (kind == Link.WAV) {
            if (payload.length < 4) throw new IOException("Invalid audio frame");
            ByteBuffer frame = ByteBuffer.wrap(payload);
            int size = frame.getInt();
            if (size <= 0 || size > 1024 || size >= frame.remaining()) throw new IOException("Invalid audio metadata");
            byte[] segment = new byte[size];
            frame.get(segment);
            File file = File.createTempFile("reply-", ".wav", getCacheDir());
            try (FileOutputStream output = new FileOutputStream(file)) {
                output.write(payload, frame.position(), frame.remaining());
            } catch (IOException error) {
                file.delete();
                throw error;
            }
            main.post(() -> {
                if (link == source) {
                    play(file, segment);
                } else {
                    file.delete();
                }
            });
            return;
        }
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
            case Link.PHASE:
                phase = value.optString("phase", "off");
                if (value.has("input")) inputAllowed = value.optBoolean("input");
                if ("off".equals(phase) || value.has("output") && !value.optBoolean("output")) {
                    clearPlayer();
                    playingSegment = null;
                }
                if (!inputAllowed && automatic) stopAuto();
                working = "transcribing".equals(phase) || "waiting".equals(phase) || "playing".equals(phase);
                if (!"listening".equals(phase)) stopCapture();
                if ("playing".equals(phase)) setStatus(R.string.playing);
                else if ("transcribing".equals(phase)) setStatus(R.string.transcribing);
                else if ("waiting".equals(phase)) setStatus(R.string.thinking);
                else {
                    setStatus(R.string.connected);
                    listen();
                }
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

    private void play(File file, byte[] segment) {
        clearPlayer();
        playingSegment = segment;
        audioFile = file;
        player = new MediaPlayer();
        try (FileInputStream input = new FileInputStream(file)) {
            player.setAudioAttributes(new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_MEDIA)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build());
            player.setDataSource(input.getFD());
            player.setOnPreparedListener(media -> {
                if (media == player) {
                    setStatus(R.string.playing);
                    media.start();
                }
            });
            player.setOnCompletionListener(media -> endPlayback(media, false));
            player.setOnErrorListener((media, what, extra) -> {
                endPlayback(media, true);
                return true;
            });
            player.prepareAsync();
        } catch (IOException | RuntimeException error) {
            endPlayback(player, true);
        }
    }

    private void endPlayback(MediaPlayer media, boolean failed) {
        if (media != player) {
            return;
        }
        clearPlayer();
        byte[] segment = playingSegment;
        playingSegment = null;
        if (link != null && segment != null) link.send(Link.PLAYED, segment);
        if (failed) setStatus(R.string.audio_error);
    }

    private void clearPlayer() {
        if (player != null) {
            player.release();
            player = null;
        }
        if (audioFile != null) {
            audioFile.delete();
            audioFile = null;
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
        stopBackgroundSession();
        setStatus(reason);
    }

    private void closeSession() {
        Link previous = link;
        link = null;
        if (previous != null) {
            previous.close();
        }
        connected = false;
        automatic = false;
        working = false;
        inputAllowed = false;
        phase = "off";
        playingSegment = null;
        stopCapture();
        clearPlayer();
    }

    @Override public void onDestroy() {
        observer = null;
        closeSession();
        stopBackgroundSession();
        super.onDestroy();
    }

    private final class Capture extends Thread {
        private final Link destination;

        Capture(Link destination) {
            super("relay-desk-mic");
            this.destination = destination;
        }

        @Override public void run() {
            AudioRecord input = null;
            try {
                int sampleRate = 16000;
                int buffer = AudioRecord.getMinBufferSize(
                    sampleRate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
                input = new AudioRecord(MediaRecorder.AudioSource.VOICE_COMMUNICATION, sampleRate,
                    AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT,
                    Math.max(buffer, 6400));
                input.startRecording();
                short[] samples = new short[1600];
                int offset = 0;
                while (!isInterrupted()) {
                    int count = input.read(samples, offset, samples.length - offset,
                        AudioRecord.READ_NON_BLOCKING);
                    if (count < 0) {
                        throw new IOException("Microphone read failed");
                    }
                    if (count == 0) {
                        Thread.sleep(10);
                        continue;
                    }
                    offset += count;
                    if (offset == samples.length) {
                        byte[] pcm = new byte[samples.length * 2];
                        for (int i = 0; i < samples.length; i++) {
                            pcm[2 * i] = (byte) samples[i];
                            pcm[2 * i + 1] = (byte) (samples[i] >> 8);
                        }
                        if (isInterrupted() || !destination.send(Link.MIC, pcm)) {
                            break;
                        }
                        offset = 0;
                    }
                }
            } catch (InterruptedException ignored) {
            } catch (IOException | RuntimeException error) {
                main.post(() -> {
                    if (capture == this) {
                        capture = null;
                        automatic = false;
                        destination.send(Link.STOP);
                        stopBackgroundSession();
                        setStatus(R.string.mic_error);
                    }
                });
            } finally {
                if (input != null) {
                    input.release();
                }
            }
        }
    }
}
