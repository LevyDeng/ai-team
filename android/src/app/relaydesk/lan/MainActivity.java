package app.relaydesk.lan;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ComponentName;
import android.content.Intent;
import android.content.ServiceConnection;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.os.IBinder;
import android.text.InputFilter;
import android.text.InputType;
import android.view.View;
import android.view.inputmethod.EditorInfo;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import java.util.ArrayList;

public final class MainActivity extends Activity {
    private static final int AUDIO_PERMISSIONS = 1;
    private static final int SCAN_PAIRING = 2;
    private EditText code;
    private EditText message;
    private Button connect;
    private Button scan;
    private Button microphone;
    private Button send;
    private TextView status;
    private TextView inputHint;
    private TextView transcript;
    private ScrollView scroll;
    private ConversationService service;
    private boolean bound;
    private boolean resumed;
    private boolean pendingStart;
    private String pendingPairing;
    private final Runnable render = this::render;
    private final ServiceConnection connection = new ServiceConnection() {
        @Override public void onServiceConnected(ComponentName name, IBinder binder) {
            service = ((ConversationService.LocalBinder) binder).service();
            service.attach(render);
            connectScannedCodeIfReady();
            startAutoIfReady();
        }

        @Override public void onServiceDisconnected(ComponentName name) {
            service = null;
            render();
        }
    };

    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved);
        setVolumeControlStream(android.media.AudioManager.STREAM_MUSIC);
        LinearLayout page = new LinearLayout(this);
        page.setOrientation(LinearLayout.VERTICAL);
        int padding = dp(16);
        page.setPadding(padding, padding, padding, padding);
        TextView title = new TextView(this);
        title.setText(R.string.app_name);
        title.setTextSize(25);
        page.addView(title);
        LinearLayout pairing = new LinearLayout(this);
        code = new EditText(this);
        code.setSingleLine(true);
        code.setSaveEnabled(false);
        code.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD);
        code.setImeOptions(EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING);
        code.setHint(R.string.pair_code);
        pairing.addView(code, new LinearLayout.LayoutParams(0, -2, 1));
        connect = new Button(this);
        connect.setOnClickListener(view -> {
            if (service != null) {
                service.connect(code.getText().toString());
            }
        });
        pairing.addView(connect);
        page.addView(pairing);
        scan = new Button(this);
        scan.setText(R.string.scan_qr);
        scan.setOnClickListener(view -> startActivityForResult(new Intent(this, PairingScanActivity.class), SCAN_PAIRING));
        page.addView(scan);
        status = new TextView(this);
        status.setPadding(0, dp(8), 0, dp(8));
        status.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
        page.addView(status);
        scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        transcript = new TextView(this);
        transcript.setTextSize(17);
        transcript.setTextIsSelectable(true);
        transcript.setPadding(0, dp(8), 0, dp(8));
        scroll.addView(transcript);
        page.addView(scroll, new LinearLayout.LayoutParams(-1, 0, 1));
        microphone = new Button(this);
        microphone.setOnClickListener(view -> toggleMic());
        page.addView(microphone);
        inputHint = new TextView(this);
        inputHint.setText(R.string.auto_input_hint);
        page.addView(inputHint);
        LinearLayout composer = new LinearLayout(this);
        message = new EditText(this);
        message.setSingleLine(true);
        message.setHint(R.string.type_message);
        message.setFilters(new InputFilter[]{new InputFilter.LengthFilter(2000)});
        message.setImeOptions(EditorInfo.IME_ACTION_SEND);
        message.setOnEditorActionListener((view, id, event) -> {
            if (id == EditorInfo.IME_ACTION_SEND) {
                sendText();
                return true;
            }
            return false;
        });
        composer.addView(message, new LinearLayout.LayoutParams(0, -2, 1));
        send = new Button(this);
        send.setText(R.string.send);
        send.setOnClickListener(view -> sendText());
        composer.addView(send);
        page.addView(composer);
        setContentView(page);
        render();
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    @Override protected void onStart() {
        super.onStart();
        bound = bindService(new Intent(this, ConversationService.class), connection, BIND_AUTO_CREATE);
    }

    @Override protected void onResume() {
        super.onResume();
        resumed = true;
        connectScannedCodeIfReady();
        startAutoIfReady();
    }

    @Override protected void onPause() {
        resumed = false;
        super.onPause();
    }

    @Override protected void onStop() {
        if (service != null) {
            service.detach(render);
            service = null;
        }
        if (bound) {
            unbindService(connection);
            bound = false;
        }
        super.onStop();
    }

    private void render() {
        boolean connected = service != null && service.isConnected();
        boolean hasLink = service != null && service.hasLink();
        boolean automatic = service != null && service.isAutomatic();
        boolean working = service != null && service.isWorking();
        connect.setEnabled(service != null);
        connect.setText(hasLink ? R.string.disconnect : R.string.connect);
        code.setEnabled(!hasLink);
        scan.setEnabled(service != null && !hasLink);
        microphone.setText(automatic ? R.string.auto_stop : R.string.auto_start);
        microphone.setEnabled(connected && (automatic || service.isInputAllowed() && !working));
        message.setEnabled(connected && !automatic && !working);
        send.setEnabled(connected && !automatic && !working);
        inputHint.setVisibility(connected && automatic ? View.VISIBLE : View.GONE);
        status.setText(service == null ? getString(R.string.connect_hint) : service.getStatus());
        String text = service == null ? "" : service.getTranscript();
        String previous = transcript.getText().toString();
        if (!text.equals(previous)) {
            if (text.startsWith(previous)) {
                transcript.append(text.substring(previous.length()));
            } else {
                transcript.setText(text);
            }
            scroll.post(() -> scroll.fullScroll(View.FOCUS_DOWN));
        }
    }

    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request == SCAN_PAIRING && result == RESULT_OK && data != null) {
            pendingPairing = data.getStringExtra(PairingScanActivity.EXTRA_CODE);
            connectScannedCodeIfReady();
        }
    }

    private void connectScannedCodeIfReady() {
        if (pendingPairing == null || service == null || !resumed) {
            return;
        }
        String scanned = pendingPairing;
        pendingPairing = null;
        if (!service.hasLink()) {
            code.setText(scanned);
            service.connect(scanned);
        }
    }

    private void toggleMic() {
        if (service == null || !service.isConnected()) {
            return;
        }
        if (service.isAutomatic()) {
            service.stopAuto();
            return;
        }
        new AlertDialog.Builder(this)
            .setTitle(R.string.auto_start)
            .setMessage(R.string.auto_input_confirm)
            .setNegativeButton(android.R.string.cancel, null)
            .setPositiveButton(R.string.auto_start, (dialog, which) -> requestMicrophone())
            .show();
    }

    private void requestMicrophone() {
        if (service == null || !service.isConnected() || !service.isInputAllowed()
                || service.isWorking() || service.isAutomatic()) {
            return;
        }
        ArrayList<String> permissions = new ArrayList<>(2);
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            permissions.add(Manifest.permission.RECORD_AUDIO);
        }
        if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
                && !getPreferences(MODE_PRIVATE).getBoolean("notification_prompted", false)) {
            permissions.add(Manifest.permission.POST_NOTIFICATIONS);
            getPreferences(MODE_PRIVATE).edit().putBoolean("notification_prompted", true).apply();
        }
        if (permissions.isEmpty()) {
            pendingStart = true;
            startAutoIfReady();
        } else {
            requestPermissions(permissions.toArray(new String[0]), AUDIO_PERMISSIONS);
        }
    }

    @Override public void onRequestPermissionsResult(int request, String[] permissions, int[] grants) {
        super.onRequestPermissionsResult(request, permissions, grants);
        if (request != AUDIO_PERMISSIONS) {
            return;
        }
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
            pendingStart = true;
            startAutoIfReady();
        } else if (service != null) {
            service.setStatus(R.string.mic_error);
        }
    }

    private void startAutoIfReady() {
        if (!pendingStart || !resumed || service == null) {
            return;
        }
        pendingStart = false;
        if (!service.isConnected() || !service.isInputAllowed() || service.isWorking() || service.isAutomatic()) {
            return;
        }
        Intent intent = new Intent(this, ConversationService.class).setAction(ConversationService.START_AUTO);
        try {
            if (Build.VERSION.SDK_INT >= 26) {
                startForegroundService(intent);
            } else {
                startService(intent);
            }
        } catch (RuntimeException error) {
            service.setStatus(R.string.background_error);
        }
    }

    private void sendText() {
        if (service != null && service.sendText(message.getText().toString().trim())) {
            message.setText("");
        }
    }
}
