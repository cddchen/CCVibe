package com.ccvibe.cclink

import android.app.Application
import com.ccvibe.cclink.data.SecureConnectionStore
import com.ccvibe.cclink.network.DaemonClient

class CCLinkApplication : Application() {
    val connectionStore by lazy { SecureConnectionStore(this) }
    val daemonClient by lazy { DaemonClient() }

    override fun onTerminate() {
        daemonClient.close()
        super.onTerminate()
    }
}
