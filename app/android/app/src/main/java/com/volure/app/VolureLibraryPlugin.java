package com.volure.app;

import android.Manifest;
import android.content.ContentUris;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Build;
import android.provider.MediaStore;
import android.util.Base64;
import android.util.Size;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.ByteArrayOutputStream;

/**
 * Reads the device's audio library through MediaStore and pulls per-track
 * artwork thumbnails. The web layer (src/platform/mobile/library.ts) maps the
 * rows into Volure's Track shape and mirrors them into SQLite.
 */
@CapacitorPlugin(
    name = "VolureLibrary",
    permissions = {
        // Split by API level: READ_EXTERNAL_STORAGE is stripped from the merged
        // manifest on API 33+ (maxSdkVersion=32), so its alias can never resolve
        // there. Only the alias actually used for the running OS is validated.
        @Permission(alias = "audioModern", strings = { Manifest.permission.READ_MEDIA_AUDIO }),
        @Permission(alias = "audioLegacy", strings = { Manifest.permission.READ_EXTERNAL_STORAGE })
    }
)
public class VolureLibraryPlugin extends Plugin {

    private String audioAlias() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU ? "audioModern" : "audioLegacy";
    }

    private boolean hasAudioPermission() {
        return getPermissionState(audioAlias()) == PermissionState.GRANTED;
    }

    @PluginMethod
    public void queryAudio(PluginCall call) {
        if (!hasAudioPermission()) {
            requestPermissionForAlias(audioAlias(), call, "audioPermissionCallback");
            return;
        }
        runQueryAudio(call);
    }

    @PermissionCallback
    private void audioPermissionCallback(PluginCall call) {
        if (hasAudioPermission()) {
            runQueryAudio(call);
        } else {
            call.reject("Audio permission denied");
        }
    }

    private void runQueryAudio(PluginCall call) {
        JSArray tracks = new JSArray();
        Uri collection = MediaStore.Audio.Media.EXTERNAL_CONTENT_URI;
        String[] projection = {
            MediaStore.Audio.Media._ID,
            MediaStore.Audio.Media.TITLE,
            MediaStore.Audio.Media.ARTIST,
            MediaStore.Audio.Media.ALBUM,
            MediaStore.Audio.Media.TRACK,
            MediaStore.Audio.Media.DURATION,
            MediaStore.Audio.Media.DATE_ADDED,
            MediaStore.Audio.Media.DATE_MODIFIED,
            MediaStore.Audio.Media.ALBUM_ID
        };
        String selection = MediaStore.Audio.Media.IS_MUSIC + " != 0";
        String sortOrder = MediaStore.Audio.Media.ARTIST + " ASC, "
            + MediaStore.Audio.Media.ALBUM + " ASC, "
            + MediaStore.Audio.Media.TRACK + " ASC";

        try (Cursor cursor = getContext().getContentResolver()
                .query(collection, projection, selection, null, sortOrder)) {
            if (cursor != null) {
                int idCol = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media._ID);
                int titleCol = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.TITLE);
                int artistCol = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.ARTIST);
                int albumCol = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.ALBUM);
                int trackCol = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.TRACK);
                int durationCol = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.DURATION);
                int dateAddedCol = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.DATE_ADDED);
                int dateModifiedCol = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.DATE_MODIFIED);
                int albumIdCol = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.ALBUM_ID);

                while (cursor.moveToNext()) {
                    long id = cursor.getLong(idCol);
                    String uri = ContentUris.withAppendedId(collection, id).toString();
                    int rawTrack = cursor.getInt(trackCol);
                    // MediaStore encodes TRACK as disc*1000 + track.
                    int trackNo = rawTrack > 0 ? rawTrack % 1000 : 0;

                    JSObject row = new JSObject();
                    row.put("id", id);
                    row.put("uri", uri);
                    row.put("title", cursor.getString(titleCol) != null ? cursor.getString(titleCol) : "");
                    row.put("artist", cursor.getString(artistCol) != null ? cursor.getString(artistCol) : "");
                    row.put("album", cursor.getString(albumCol) != null ? cursor.getString(albumCol) : "");
                    row.put("genre", (Object) null);
                    row.put("trackNo", trackNo);
                    row.put("durationMs", cursor.getLong(durationCol));
                    row.put("dateAddedSec", cursor.getLong(dateAddedCol));
                    row.put("dateModifiedSec", cursor.getLong(dateModifiedCol));
                    row.put("relativePath", (Object) null);
                    row.put("albumId", cursor.getLong(albumIdCol));
                    tracks.put(row);
                }
            }
        } catch (Exception e) {
            call.reject("MediaStore query failed: " + e.getMessage(), e);
            return;
        }

        JSObject result = new JSObject();
        result.put("tracks", tracks);
        call.resolve(result);
    }

    /** Album/embedded artwork for a track as a base64 JPEG, or {data: null}. */
    @PluginMethod
    public void getArt(PluginCall call) {
        String idString = call.getString("id");
        if (idString == null) {
            call.reject("Missing id");
            return;
        }
        long id;
        try {
            id = Long.parseLong(idString);
        } catch (NumberFormatException e) {
            call.reject("Invalid id");
            return;
        }

        JSObject none = new JSObject();
        none.put("data", (Object) null);

        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            call.resolve(none);
            return;
        }

        try {
            Uri uri = ContentUris.withAppendedId(MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, id);
            Bitmap bitmap = getContext().getContentResolver()
                .loadThumbnail(uri, new Size(512, 512), null);
            if (bitmap == null) {
                call.resolve(none);
                return;
            }
            ByteArrayOutputStream stream = new ByteArrayOutputStream();
            bitmap.compress(Bitmap.CompressFormat.JPEG, 85, stream);
            String base64 = Base64.encodeToString(stream.toByteArray(), Base64.NO_WRAP);
            JSObject result = new JSObject();
            result.put("format", "image/jpeg");
            result.put("data", base64);
            call.resolve(result);
        } catch (Exception e) {
            // No thumbnail for this track is a normal outcome, not an error.
            call.resolve(none);
        }
    }
}
