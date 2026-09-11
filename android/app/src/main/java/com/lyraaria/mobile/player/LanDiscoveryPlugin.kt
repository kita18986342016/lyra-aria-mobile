package com.lyraaria.mobile.player

import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.SocketTimeoutException

/** 局域网设备发现：向 255.255.255.255:DISC_PORT 广播 DSH_SYNC_PING，收集应答（电脑同步服务）。 */
@CapacitorPlugin(name = "LanDiscovery")
class LanDiscoveryPlugin : Plugin() {

    @PluginMethod
    fun scan(call: PluginCall) {
        val discPort = call.getInt("discPort") ?: 41230
        val timeoutMs = (call.getInt("timeoutMs") ?: 2500).coerceIn(500, 8000)
        val found = JSArray()
        val seen = HashSet<String>()
        Thread {
            var sock: DatagramSocket? = null
            try {
                sock = DatagramSocket()
                sock.broadcast = true
                val ping = "DSH_SYNC_PING".toByteArray(Charsets.UTF_8)
                val bcast = InetAddress.getByName("255.255.255.255")
                sock.send(DatagramPacket(ping, ping.size, bcast, discPort))
                val deadline = System.currentTimeMillis() + timeoutMs
                val buf = ByteArray(1024)
                while (true) {
                    val remain = deadline - System.currentTimeMillis()
                    if (remain <= 0) break
                    sock.soTimeout = remain.toInt()
                    val pkt = DatagramPacket(buf, buf.size)
                    try {
                        sock.receive(pkt)
                    } catch (_: SocketTimeoutException) {
                        break
                    }
                    val text = String(pkt.data, 0, pkt.length)
                    try {
                        val j = org.json.JSONObject(text)
                        val ip = j.optString("ip", pkt.address.hostAddress ?: "")
                        val port = j.optInt("port", 8790)
                        val name = j.optString("name", "深空折韵")
                        val identity = j.optString("identity", "")
                        val key = "$ip:$port"
                        if (ip.isNotEmpty() && !seen.contains(key)) {
                            seen.add(key)
                            found.put(JSObject().apply { put("ip", ip); put("port", port); put("name", name); put("identity", identity) })
                        }
                    } catch (_: Exception) { /* 非 JSON 应答忽略 */ }
                }
                sock.close()
                val ret = JSObject()
                ret.put("devices", found)
                call.resolve(ret)
            } catch (e: Exception) {
                try { sock?.close() } catch (_: Exception) {}
                val ret = JSObject()
                ret.put("devices", found)
                call.resolve(ret)
            }
        }.start()
    }
}
