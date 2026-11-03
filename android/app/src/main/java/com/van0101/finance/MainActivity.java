package com.van0101.finance;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.Locale;
import java.util.Map;

/**
 * Hosts the web app (bundled under assets/www) in a WebView.
 *
 * The files are served from https://appassets.androidplatform.net/www/ (Android's reserved
 * host for app assets) instead of file://, so the page gets a real https origin: IndexedDB,
 * ES modules and the clipboard then work exactly as on the website. The page's CSP allows no
 * outside hosts, so nothing leaves the phone.
 */
public class MainActivity extends Activity {

    private static final String HOST = "appassets.androidplatform.net";
    private static final String START_URL = "https://" + HOST + "/www/index.html";
    private static final int REQ_PICK_FILES = 1;
    private static final int REQ_SAVE_FILE = 2;

    private WebView web;
    private ValueCallback<Uri[]> fileCallback;
    private String pendingSaveText;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        web = new WebView(this);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);           // localStorage + IndexedDB
        s.setAllowFileAccess(false);            // nothing is read from file:// URLs
        s.setAllowContentAccess(false);
        s.setSupportMultipleWindows(false);     // target=_blank links come through shouldOverrideUrlLoading

        web.setWebViewClient(new AssetClient());
        web.setWebChromeClient(new FileChooserClient());
        web.addJavascriptInterface(new Bridge(), "FinanceAndroid");

        if (savedInstanceState == null || web.restoreState(savedInstanceState) == null) {
            web.loadUrl(START_URL);
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        // The web app routes with #hash, so Back walks through its screens first.
        if (web.canGoBack()) {
            web.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            web.destroy();
        }
        super.onDestroy();
    }

    /** Serves assets/www for the app host, and sends every other link to the browser. */
    private class AssetClient extends WebViewClient {

        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            Uri url = request.getUrl();
            if (!HOST.equals(url.getHost())) {
                return null; // anything else: the page's CSP already blocks outside hosts
            }
            String path = url.getPath() == null ? "" : url.getPath();
            if (path.startsWith("/")) {
                path = path.substring(1);
            }
            if (path.endsWith("/")) {
                path = path + "index.html";
            }
            if (!path.startsWith("www/") || path.contains("..")) {
                return notFound();
            }
            try {
                InputStream in = getAssets().open(path);
                WebResourceResponse res = new WebResourceResponse(mimeType(path), "utf-8", in);
                res.setResponseHeaders(Collections.singletonMap("Cache-Control", "no-cache"));
                return res;
            } catch (IOException e) {
                return notFound();
            }
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri url = request.getUrl();
            if (HOST.equals(url.getHost())) {
                return false;
            }
            if ("https".equals(url.getScheme()) || "http".equals(url.getScheme()) || "mailto".equals(url.getScheme())) {
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, url));
                } catch (ActivityNotFoundException e) {
                    Toast.makeText(MainActivity.this, "No app can open this link", Toast.LENGTH_SHORT).show();
                }
            }
            return true;
        }

        private WebResourceResponse notFound() {
            Map<String, String> headers = Collections.emptyMap();
            return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", headers,
                    new java.io.ByteArrayInputStream(new byte[0]));
        }
    }

    private static String mimeType(String path) {
        String p = path.toLowerCase(Locale.ROOT);
        if (p.endsWith(".html")) return "text/html";
        if (p.endsWith(".js")) return "text/javascript";
        if (p.endsWith(".css")) return "text/css";
        if (p.endsWith(".json") || p.endsWith(".webmanifest")) return "application/manifest+json";
        if (p.endsWith(".png")) return "image/png";
        if (p.endsWith(".svg")) return "image/svg+xml";
        return "application/octet-stream";
    }

    /** Opens the system file picker for <input type="file">, with multi-select. */
    private class FileChooserClient extends WebChromeClient {
        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
            if (fileCallback != null) {
                fileCallback.onReceiveValue(null);
            }
            fileCallback = callback;

            Intent pick = new Intent(Intent.ACTION_GET_CONTENT);
            pick.addCategory(Intent.CATEGORY_OPENABLE);
            pick.setType("*/*");
            // No MIME filter: phones label .xlsx and .csv files inconsistently (often octet-stream),
            // so filtering would hide them. The page checks each file itself.
            if (params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) {
                pick.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
            }
            try {
                startActivityForResult(pick, REQ_PICK_FILES);
            } catch (ActivityNotFoundException e) {
                fileCallback.onReceiveValue(null);
                fileCallback = null;
                return false;
            }
            return true;
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQ_PICK_FILES) {
            if (fileCallback == null) return;
            Uri[] result = null;
            if (resultCode == RESULT_OK && data != null) {
                ClipData clip = data.getClipData();
                if (clip != null && clip.getItemCount() > 0) {
                    result = new Uri[clip.getItemCount()];
                    for (int i = 0; i < clip.getItemCount(); i++) {
                        result[i] = clip.getItemAt(i).getUri();
                    }
                } else if (data.getData() != null) {
                    result = new Uri[]{data.getData()};
                }
            }
            fileCallback.onReceiveValue(result);
            fileCallback = null;
        } else if (requestCode == REQ_SAVE_FILE) {
            String text = pendingSaveText;
            pendingSaveText = null;
            if (resultCode != RESULT_OK || data == null || data.getData() == null || text == null) return;
            try (OutputStream out = getContentResolver().openOutputStream(data.getData())) {
                if (out == null) throw new IOException("No output stream");
                out.write(text.getBytes(StandardCharsets.UTF_8));
                Toast.makeText(this, "Saved", Toast.LENGTH_SHORT).show();
            } catch (IOException e) {
                Toast.makeText(this, "Couldn't save the file", Toast.LENGTH_LONG).show();
            }
        }
    }

    /** Called from the page as window.FinanceAndroid.saveFile(...) for CSV and backup exports. */
    private class Bridge {
        @JavascriptInterface
        public void saveFile(String name, String mime, String text) {
            runOnUiThread(() -> {
                pendingSaveText = text;
                Intent save = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                save.addCategory(Intent.CATEGORY_OPENABLE);
                save.setType(mime == null || mime.isEmpty() ? "application/octet-stream" : mime);
                save.putExtra(Intent.EXTRA_TITLE, name);
                try {
                    startActivityForResult(save, REQ_SAVE_FILE);
                } catch (ActivityNotFoundException e) {
                    pendingSaveText = null;
                    Toast.makeText(MainActivity.this, "No app can save files", Toast.LENGTH_LONG).show();
                }
            });
        }
    }
}
