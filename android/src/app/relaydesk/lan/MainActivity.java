package app.relaydesk.lan;

import android.app.Activity;
import android.content.ComponentName;
import android.content.Intent;
import android.content.ServiceConnection;
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

public final class MainActivity extends Activity {
    private static final int SCAN_PAIRING = 2;
    private EditText code;
    private EditText message;
    private Button connect;
    private Button scan;
    private Button send;
    private TextView status;
    private TextView transcript;
    private ScrollView scroll;
    private ConversationService service;
    private boolean bound;
    private boolean resumed;
    private String pendingPairing;
    private final Runnable render = this::render;
    private final ServiceConnection connection = new ServiceConnection() {
        @Override public void onServiceConnected(ComponentName name, IBinder binder) {
            service = ((ConversationService.LocalBinder) binder).service();
            service.attach(render);
            connectScannedCodeIfReady();
        }

        @Override public void onServiceDisconnected(ComponentName name) {
            service = null;
            render();
        }
    };

    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved);
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
        connect.setEnabled(service != null);
        connect.setText(hasLink ? R.string.disconnect : R.string.connect);
        code.setEnabled(!hasLink);
        scan.setEnabled(service != null && !hasLink);
        message.setEnabled(connected);
        send.setEnabled(connected);
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

    private void sendText() {
        if (service != null && service.sendText(message.getText().toString().trim())) {
            message.setText("");
        }
    }
}
