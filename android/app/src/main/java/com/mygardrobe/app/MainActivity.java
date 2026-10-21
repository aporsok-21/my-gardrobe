package com.mygardrobe.app;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(PagePicturePlugin.class);   // a shop's picture from a page the person opens (PagePicturePlugin.java)
        super.onCreate(savedInstanceState);
    }
}
