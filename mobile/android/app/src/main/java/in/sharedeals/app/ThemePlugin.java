package in.sharedeals.app;

import android.app.Activity;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.res.Configuration;
import android.view.Window;

import androidx.appcompat.app.AppCompatDelegate;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * The site's Light / Dark / System choice (public/app.js, "colour theme"), mirrored natively so the
 * status and navigation bar icons, the WebView background, the offline page and the next launch's
 * splash screen all match it. The site calls AppTheme.set({ mode }) whenever the theme is applied.
 */
@CapacitorPlugin(name = "AppTheme")
public class ThemePlugin extends Plugin {
    private static final String PREFS = "app_theme";
    private static final String KEY = "mode";
    private static final int DARK_BG = 0xFF141413; // --bg in public/styles.css
    private static final int LIGHT_BG = 0xFFF6F6F4;

    @PluginMethod
    public void set(PluginCall call) {
        String mode = call.getString("mode", "system");
        if (!"light".equals(mode) && !"dark".equals(mode)) mode = "system";
        Activity activity = getActivity();
        activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY, mode).apply();
        final String m = mode;
        activity.runOnUiThread(() -> {
            setNightMode(m);
            applyBars(activity);
            if (getBridge() != null && getBridge().getWebView() != null) {
                getBridge().getWebView().setBackgroundColor(background(activity));
            }
            call.resolve();
        });
    }

    /** Called from MainActivity before the WebView is created, using the last saved choice. */
    static void applySaved(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        setNightMode(prefs.getString(KEY, "system"));
    }

    static void setNightMode(String mode) {
        int night = "dark".equals(mode) ? AppCompatDelegate.MODE_NIGHT_YES
            : "light".equals(mode) ? AppCompatDelegate.MODE_NIGHT_NO
            : AppCompatDelegate.MODE_NIGHT_FOLLOW_SYSTEM;
        if (AppCompatDelegate.getDefaultNightMode() != night) AppCompatDelegate.setDefaultNightMode(night);
    }

    static boolean isDark(Activity activity) {
        int ui = activity.getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK;
        return ui == Configuration.UI_MODE_NIGHT_YES;
    }

    static int background(Activity activity) {
        return isDark(activity) ? DARK_BG : LIGHT_BG;
    }

    /** Dark icons on a light page, light icons on a dark one. */
    static void applyBars(Activity activity) {
        Window window = activity.getWindow();
        boolean light = !isDark(activity);
        WindowInsetsControllerCompat bars = WindowCompat.getInsetsController(window, window.getDecorView());
        bars.setAppearanceLightStatusBars(light);
        bars.setAppearanceLightNavigationBars(light);
        window.getDecorView().setBackgroundColor(light ? LIGHT_BG : DARK_BG);
    }
}
