package in.sharedeals.app;

import android.content.Intent;
import android.content.res.Configuration;
import android.net.Uri;
import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        setIntent(fromShare(getIntent()));
        registerPlugin(ThemePlugin.class);
        // Apply the saved Light/Dark/System choice before any UI exists, so nothing flashes.
        ThemePlugin.applySaved(this);
        super.onCreate(savedInstanceState);
        ThemePlugin.applyBars(this);
        if (getBridge() != null) getBridge().getWebView().setBackgroundColor(ThemePlugin.background(this));
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(fromShare(intent));
    }

    /**
     * "Share → ShareDeals" from another app (Amazon, Flipkart, Chrome…): turn the shared text into a
     * link to the site's Post-a-deal page, /submit?shared=<text>. Capacitor's App plugin then hands it
     * to the page like any other app link (getLaunchUrl / appUrlOpen → openAppUrl in public/app.js),
     * and the page finds the deal link in the text. Anything else passes through unchanged.
     */
    static Intent fromShare(Intent intent) {
        if (intent == null || !Intent.ACTION_SEND.equals(intent.getAction())) return intent;
        String type = intent.getType();
        if (type == null || !type.startsWith("text/")) return intent;
        CharSequence text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
        String subject = intent.getStringExtra(Intent.EXTRA_SUBJECT);
        String shared = ((subject != null ? subject + "\n" : "") + (text != null ? text : "")).trim();
        Uri link = new Uri.Builder().scheme("https").authority("www.sharedeals.in").path("/submit")
            .appendQueryParameter("shared", shared).build();
        return new Intent(Intent.ACTION_VIEW, link);
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        // The device switched light/dark (uiMode is in configChanges, so the activity isn't recreated).
        ThemePlugin.applyBars(this);
        if (getBridge() != null) getBridge().getWebView().setBackgroundColor(ThemePlugin.background(this));
    }
}
