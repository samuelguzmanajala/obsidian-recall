package com.recall.voice

import android.graphics.Color
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.ui.Modifier
import androidx.lifecycle.lifecycleScope
import com.recall.voice.ui.App
import com.recall.voice.ui.Typesetter
import com.recall.voice.ui.theme.RecallTheme
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    // The top bar is midnight in both themes, so the status bar always carries light icons.
    enableEdgeToEdge(statusBarStyle = SystemBarStyle.dark(Color.TRANSPARENT))
    super.onCreate(savedInstanceState)
    // Load the formula typesetter's tables and fonts off the main thread before a card needs them.
    lifecycleScope.launch(Dispatchers.Default) { Typesetter.warmUp(applicationContext) }
    setContent {
      RecallTheme {
        Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
          App()
        }
      }
    }
  }
}
