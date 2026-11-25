package app.relaydesk.lan;

import android.content.Context;
import android.view.View;
import android.view.ViewTreeObserver;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.Map;

final class TranscriptView extends ScrollView {
    private final LinearLayout content;
    private final TextView title;
    private final Map<String, TextView> rows = new LinkedHashMap<>();
    private final int gap;
    private boolean restorePending;

    TranscriptView(Context context) {
        super(context);
        gap = Math.round(12 * getResources().getDisplayMetrics().density);
        setFillViewport(true);
        content = new LinearLayout(context);
        content.setOrientation(LinearLayout.VERTICAL);
        content.setPadding(0, gap, 0, gap);
        title = newRow();
        title.setVisibility(GONE);
        content.addView(title);
        addView(content);
    }

    void update(String conversation, Map<String, String> messages) {
        if (matches(conversation, messages)) return;
        if (!restorePending) restorePositionAfterLayout();
        if (!conversation.contentEquals(title.getText())) {
            title.setText(conversation);
            title.setVisibility(conversation.isEmpty() ? GONE : VISIBLE);
        }
        Iterator<Map.Entry<String, TextView>> existing = rows.entrySet().iterator();
        while (existing.hasNext()) {
            Map.Entry<String, TextView> entry = existing.next();
            if (!messages.containsKey(entry.getKey())) {
                content.removeView(entry.getValue());
                existing.remove();
            }
        }
        for (Map.Entry<String, String> entry : messages.entrySet()) {
            TextView row = rows.get(entry.getKey());
            if (row == null) {
                row = newRow();
                rows.put(entry.getKey(), row);
                content.addView(row);
            }
            if (!entry.getValue().contentEquals(row.getText())) row.setText(entry.getValue());
        }
    }

    private boolean matches(String conversation, Map<String, String> messages) {
        if (messages.size() != rows.size() || !conversation.contentEquals(title.getText())) return false;
        for (Map.Entry<String, String> entry : messages.entrySet()) {
            TextView row = rows.get(entry.getKey());
            if (row == null || !entry.getValue().contentEquals(row.getText())) return false;
        }
        return true;
    }

    private TextView newRow() {
        TextView row = new TextView(getContext());
        row.setTextSize(17);
        row.setTextIsSelectable(true);
        row.setPadding(0, 0, 0, gap);
        return row;
    }

    private void restorePositionAfterLayout() {
        restorePending = true;
        final int scroll = getScrollY();
        final boolean follow = content.getHeight() - getHeight() - scroll <= 4 * gap;
        View first = title.getVisibility() == VISIBLE && title.getBottom() > scroll ? title : null;
        if (first == null) {
            for (TextView row : rows.values()) {
                if (row.getBottom() > scroll) {
                    first = row;
                    break;
                }
            }
        }
        final View anchor = first;
        final int offset = anchor == null ? 0 : scroll - anchor.getTop();
        getViewTreeObserver().addOnPreDrawListener(new ViewTreeObserver.OnPreDrawListener() {
            @Override public boolean onPreDraw() {
                getViewTreeObserver().removeOnPreDrawListener(this);
                restorePending = false;
                if (follow) scrollTo(0, Math.max(0, content.getHeight() - getHeight()));
                else if (anchor != null && anchor.getParent() == content) scrollTo(0, anchor.getTop() + offset);
                else scrollTo(0, 0);
                return true;
            }
        });
    }
}
