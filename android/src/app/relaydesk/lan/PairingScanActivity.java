package app.relaydesk.lan;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.ImageFormat;
import android.graphics.Matrix;
import android.graphics.SurfaceTexture;
import android.hardware.Camera;
import android.os.Bundle;
import android.view.TextureView;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import com.google.zxing.BinaryBitmap;
import com.google.zxing.PlanarYUVLuminanceSource;
import com.google.zxing.ReaderException;
import com.google.zxing.common.HybridBinarizer;
import com.google.zxing.qrcode.QRCodeReader;
import java.io.IOException;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@SuppressWarnings("deprecation")
public final class PairingScanActivity extends Activity implements TextureView.SurfaceTextureListener {
    static final String EXTRA_CODE = "pairing_code";
    private static final String PREFIX = "relaydesk:";
    private static final int CAMERA_PERMISSION = 1;
    private final ExecutorService decoder = Executors.newSingleThreadExecutor();
    private TextureView preview;
    private TextView status;
    private Camera camera;
    private boolean resumed;

    @Override protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        LinearLayout page = new LinearLayout(this);
        page.setOrientation(LinearLayout.VERTICAL);
        status = new TextView(this);
        status.setText(R.string.scan_hint);
        int padding = Math.round(16 * getResources().getDisplayMetrics().density);
        status.setPadding(padding, padding, padding, padding);
        page.addView(status);
        preview = new TextureView(this);
        preview.setSurfaceTextureListener(this);
        page.addView(preview, new LinearLayout.LayoutParams(-1, 0, 1));
        Button cancel = new Button(this);
        cancel.setText(android.R.string.cancel);
        cancel.setOnClickListener(view -> finish());
        page.addView(cancel);
        setContentView(page);
        if (saved == null && checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.CAMERA}, CAMERA_PERMISSION);
        }
    }

    @Override protected void onResume() {
        super.onResume();
        resumed = true;
        startCamera();
    }

    @Override protected void onPause() {
        resumed = false;
        stopCamera();
        super.onPause();
    }

    @Override protected void onDestroy() {
        decoder.shutdownNow();
        super.onDestroy();
    }

    @Override public void onRequestPermissionsResult(int request, String[] permissions, int[] grants) {
        super.onRequestPermissionsResult(request, permissions, grants);
        if (request == CAMERA_PERMISSION) {
            if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
                startCamera();
            } else {
                status.setText(R.string.scan_camera_denied);
            }
        }
    }

    private void startCamera() {
        if (!resumed || isFinishing() || camera != null || !preview.isAvailable()
                || checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            return;
        }
        try {
            Camera.CameraInfo info = new Camera.CameraInfo();
            int count = Camera.getNumberOfCameras();
            int id = 0;
            for (; id < count; id++) {
                Camera.getCameraInfo(id, info);
                if (info.facing == Camera.CameraInfo.CAMERA_FACING_BACK) {
                    break;
                }
            }
            if (id == count) {
                status.setText(R.string.scan_camera_failed);
                return;
            }
            camera = Camera.open(id);
            Camera.Parameters settings = camera.getParameters();
            settings.setPreviewFormat(ImageFormat.NV21);
            List<String> focusModes = settings.getSupportedFocusModes();
            if (focusModes != null && focusModes.contains(Camera.Parameters.FOCUS_MODE_CONTINUOUS_PICTURE)) {
                settings.setFocusMode(Camera.Parameters.FOCUS_MODE_CONTINUOUS_PICTURE);
            }
            camera.setParameters(settings);
            Camera.Size size = settings.getPreviewSize();
            int rotation = (info.orientation - 90 * getWindowManager().getDefaultDisplay().getRotation() + 360) % 360;
            camera.setDisplayOrientation(rotation);
            int width = rotation % 180 == 0 ? size.width : size.height;
            int height = rotation % 180 == 0 ? size.height : size.width;
            float scale = Math.max((float) preview.getWidth() / width, (float) preview.getHeight() / height);
            Matrix transform = new Matrix();
            transform.setScale(scale * width / preview.getWidth(), scale * height / preview.getHeight(),
                    preview.getWidth() / 2f, preview.getHeight() / 2f);
            preview.setTransform(transform);
            camera.setPreviewTexture(preview.getSurfaceTexture());
            camera.startPreview();
            status.setText(R.string.scan_hint);
            nextFrame(camera, size);
        } catch (IOException | RuntimeException error) {
            stopCamera();
            status.setText(R.string.scan_camera_failed);
        }
    }

    private void nextFrame(Camera source, Camera.Size size) {
        source.setOneShotPreviewCallback((data, current) -> {
            if (camera == current && resumed) {
                decoder.execute(() -> {
                    String code = decode(data, size.width, size.height);
                    runOnUiThread(() -> {
                        if (camera != current || !resumed || isFinishing()) {
                            return;
                        }
                        if (code != null) {
                            setResult(RESULT_OK, new Intent().putExtra(EXTRA_CODE, code));
                            finish();
                        } else {
                            nextFrame(current, size);
                        }
                    });
                });
            }
        });
    }

    static String decode(byte[] data, int width, int height) {
        if (data == null || data.length < width * height) {
            return null;
        }
        PlanarYUVLuminanceSource image = new PlanarYUVLuminanceSource(data, width, height, 0, 0, width, height, false);
        try {
            String text = new QRCodeReader().decode(new BinaryBitmap(new HybridBinarizer(image))).getText();
            return text.startsWith(PREFIX) ? text.substring(PREFIX.length()) : null;
        } catch (ReaderException error) {
            return null;
        }
    }

    private void stopCamera() {
        Camera current = camera;
        camera = null;
        if (current != null) {
            current.release();
        }
    }

    @Override public void onSurfaceTextureAvailable(SurfaceTexture texture, int width, int height) {
        startCamera();
    }

    @Override public void onSurfaceTextureSizeChanged(SurfaceTexture texture, int width, int height) {
    }

    @Override public boolean onSurfaceTextureDestroyed(SurfaceTexture texture) {
        stopCamera();
        return true;
    }

    @Override public void onSurfaceTextureUpdated(SurfaceTexture texture) {
    }
}
