package com.mygardrobe.app;

import android.graphics.Color;
import android.os.Bundle;
import android.view.View;

import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(PagePicturePlugin.class);   // a shop's picture from a page the person opens (PagePicturePlugin.java)
        super.onCreate(savedInstanceState);
        // Newer Androids draw apps under the status bar and the navigation bar; keep the app between them
        View web = getBridge().getWebView(), box = (View) web.getParent();
        box.setBackgroundColor(Color.parseColor("#F6F2EA"));
        ViewCompat.setOnApplyWindowInsetsListener(box, (v, insets) -> {
            Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            return WindowInsetsCompat.CONSUMED;
        });
    }
}
