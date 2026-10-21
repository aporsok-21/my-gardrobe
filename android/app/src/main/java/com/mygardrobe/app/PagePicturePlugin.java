package com.mygardrobe.app;

import android.annotation.SuppressLint;
import android.app.Dialog;
import android.graphics.Color;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import android.view.Gravity;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Some shops (Zara, Mango, H&M, …) don't let servers read their pages. When the person agrees, the page
 * opens here in a normal browser window, the way they would look at it themselves; once it has loaded we
 * read the product picture the shop names for link previews (og:image / JSON-LD), download it with the
 * page's own cookies, and close the window. Called from app.html as Capacitor.Plugins.PagePicture.get({ url }).
 */
@CapacitorPlugin(name = "PagePicture")
public class PagePicturePlugin extends Plugin {
    private static final long GIVE_UP_MS = 30000;
    private static final int IMAGE_MAX = 8 * 1024 * 1024;

    // What the page says its main picture is
    private static final String FIND_PICTURE =
        "(function(){function m(k){var e=document.querySelector('meta[property=\"'+k+'\"],meta[name=\"'+k+'\"]');return e&&e.content||'';}"
        + "var u=m('og:image')||m('og:image:url')||m('twitter:image');"
        + "if(!u){var s=document.querySelectorAll('script[type=\"application/ld+json\"]');"
        + "for(var i=0;i<s.length&&!u;i++){try{var j=JSON.parse(s[i].textContent),l=[].concat(j['@graph']||j);"
        + "for(var k=0;k<l.length&&!u;k++){var t=[].concat(l[k]['@type']||[]);if(t.indexOf('Product')>=0||t.indexOf('ProductGroup')>=0){var im=[].concat(l[k].image||[])[0];u=im&&(im.url||im.contentUrl||im)||'';}}}catch(e){}}}"
        + "return u?new URL(u,location.href).href:'';})()";

    private Dialog dialog;
    private WebView web;
    private PluginCall pending;
    private final Handler main = new Handler(Looper.getMainLooper());

    @PluginMethod
    public void get(PluginCall call) {
        String url = call.getString("url", "");
        if (!url.startsWith("https://") && !url.startsWith("http://")) { call.reject("link"); return; }
        if (pending != null) { call.reject("busy"); return; }
        pending = call;
        getActivity().runOnUiThread(() -> open(url, call.getString("title", "")));
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void open(String url, String title) {
        dialog = new Dialog(getActivity(), android.R.style.Theme_Material_Light_NoActionBar);
        LinearLayout box = new LinearLayout(getActivity());
        box.setOrientation(LinearLayout.VERTICAL);
        box.setBackgroundColor(Color.parseColor("#F6F2EA"));

        LinearLayout bar = new LinearLayout(getActivity());
        bar.setGravity(Gravity.CENTER_VERTICAL);
        int pad = (int) (12 * getActivity().getResources().getDisplayMetrics().density);
        bar.setPadding(pad * 2, pad, pad, pad);
        TextView label = new TextView(getActivity());
        label.setText(title);
        label.setTextColor(Color.parseColor("#2B2B2B"));
        label.setTextSize(15);
        bar.addView(label, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        Button cancel = new Button(getActivity());
        cancel.setText("✕");
        cancel.setOnClickListener(v -> finish(null, "cancelled"));
        bar.addView(cancel);
        box.addView(bar);

        web = new WebView(getActivity());
        WebSettings ws = web.getSettings();
        ws.setJavaScriptEnabled(true);
        ws.setDomStorageEnabled(true);
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true);
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) { return false; }
            @Override public void onPageFinished(WebView v, String loaded) { look(1); }
        });
        box.addView(web, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));

        dialog.setContentView(box);
        dialog.setOnCancelListener(d -> finish(null, "cancelled"));
        dialog.show();
        web.loadUrl(url);
        main.postDelayed(() -> finish(null, "nothing"), GIVE_UP_MS);
    }

    // The shop may still be swapping in the real page (a check page first, pictures set by script): ask a few times
    private void look(int round) {
        if (web == null || pending == null) return;
        web.evaluateJavascript(FIND_PICTURE, value -> {
            if (web == null || pending == null) return;
            String img = "";
            try { img = new JSONObject("{\"v\":" + value + "}").optString("v", ""); } catch (Exception e) { /* null */ }
            if (!img.isEmpty()) { String page = web.getUrl(), ua = web.getSettings().getUserAgentString(); download(img, page, ua); }
            else if (round < 8) main.postDelayed(() -> look(round + 1), 1200);
        });
    }

    private void download(String img, String page, String ua) {
        String cookies = CookieManager.getInstance().getCookie(img);
        new Thread(() -> {
            String data = "";
            try {
                HttpURLConnection c = (HttpURLConnection) new URL(img).openConnection();
                c.setConnectTimeout(12000); c.setReadTimeout(15000);
                c.setRequestProperty("User-Agent", ua);
                if (page != null) c.setRequestProperty("Referer", page);
                if (cookies != null) c.setRequestProperty("Cookie", cookies);
                String type = c.getContentType();
                if (c.getResponseCode() == 200 && type != null && type.startsWith("image/")) {
                    try (InputStream in = c.getInputStream(); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
                        byte[] buf = new byte[16384]; int n, total = 0;
                        while ((n = in.read(buf)) > 0) { total += n; if (total > IMAGE_MAX) throw new Exception("big"); out.write(buf, 0, n); }
                        data = "data:" + type.split(";")[0] + ";base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP);
                    }
                }
            } catch (Exception e) { /* the picture's address is still sent back */ }
            String photo = data;
            main.post(() -> { JSObject r = new JSObject(); r.put("image", img); r.put("photo", photo); finish(r, null); });
        }).start();
    }

    private void finish(JSObject result, String error) {
        main.removeCallbacksAndMessages(null);
        PluginCall call = pending; pending = null;
        if (web != null) { web.stopLoading(); web.destroy(); web = null; }
        if (dialog != null) { dialog.setOnCancelListener(null); dialog.dismiss(); dialog = null; }
        if (call == null) return;
        if (result != null) call.resolve(result); else call.reject(error);
    }
}
