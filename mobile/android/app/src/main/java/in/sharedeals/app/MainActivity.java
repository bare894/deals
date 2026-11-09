package in.sharedeals.app;

import android.content.res.Configuration;
import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ThemePlugin.class);
        // Apply the saved Light/Dark/System choice before any UI exists, so nothing flashes.
        ThemePlugin.applySaved(this);
        super.onCreate(savedInstanceState);
        ThemePlugin.applyBars(this);
        if (getBridge() != null) getBridge().getWebView().setBackgroundColor(ThemePlugin.background(this));
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        // The device switched light/dark (uiMode is in configChanges, so the activity isn't recreated).
        ThemePlugin.applyBars(this);
        if (getBridge() != null) getBridge().getWebView().setBackgroundColor(ThemePlugin.background(this));
    }
}
