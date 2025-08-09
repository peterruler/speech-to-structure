const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const FormData = require('form-data');

// Funktion für Whisper-Transkription nur mit lokalem Ollama dimavz/whisper-tiny
// oben bei den imports ergänzen:
const { execFile } = require('child_process');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
ffmpeg.setFfmpegPath(ffmpegPath);

require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Multer-Konfiguration für Audio-Upload
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadsDir = './uploads';
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir);
    }
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + file.originalname);
  }
});

const upload = multer({ storage: storage });

// Startup-Cleanup: Lösche alle vorhandenen Audio-Dateien beim Start
function cleanupUploadsOnStartup() {
  const uploadsDir = './uploads';
  if (fs.existsSync(uploadsDir)) {
    const files = fs.readdirSync(uploadsDir);
    files.forEach(file => {
      const filePath = path.join(uploadsDir, file);
      try {
        fs.unlinkSync(filePath);
        console.log('Startup-Cleanup: Audio-Datei gelöscht:', file);
      } catch (error) {
        console.error('Fehler beim Startup-Cleanup:', file, error);
      }
    });
  }
}

// Cleanup beim Start ausführen
cleanupUploadsOnStartup();

// Hilfsfunktion: nach 16 kHz / mono WAV konvertieren (Whisper mag das)
function convertToWav16kMono(inputPath) {
  return new Promise((resolve, reject) => {
    const outPath = inputPath.replace(/\.(\w+)$/, '') + '-16k.wav';
    ffmpeg(inputPath)
      .audioFrequency(16000)
      .audioChannels(1)
      .format('wav')
      .on('end', () => resolve(outPath))
      .on('error', reject)
      .save(outPath);
  });
}

// NEU: lokale Transkription via Python faster-whisper
async function transcribeAudio(audioFilePath) {
  // Dateigröße prüfen (deins bleibt erhalten)
  const stats = fs.statSync(audioFilePath);
  if (stats.size > 25 * 1024 * 1024) {
    throw new Error('Audio-Datei ist zu groß (>25MB). Bitte kleinere Datei verwenden.');
  }

  // In 16kHz/mono WAV umwandeln
  const wavPath = await convertToWav16kMono(audioFilePath);

  // Python-Skript aufrufen
  const pythonBin = process.env.PYTHON_BIN || 'python3';
  return new Promise((resolve, reject) => {
    execFile(
      pythonBin,
      ['transcribe.py', wavPath],
      { timeout: 120000 }, // 2 min
      (err, stdout, stderr) => {
        try {
          if (err) {
            return reject(new Error(`Transkription fehlgeschlagen: ${stderr || err.message}`));
          }
          const out = JSON.parse(stdout || '{}');
          if (out.error) return reject(new Error(out.error));
          if (!out.text) return reject(new Error('Keine Transkription erhalten.'));
          resolve(out.text);
        } catch (e) {
          reject(new Error(`Ungültige Transkriptionsausgabe: ${e.message}\nSTDOUT: ${stdout}`));
        } finally {
          // konvertierte WAV wieder aufräumen
          try { fs.unlinkSync(wavPath); } catch (_) {}
        }
      }
    );
  });
}

// Hilfsfunktion für intelligentes Text-Parsing als Fallback
function parseTextToJson(responseText, originalText) {
  console.log('Versuche intelligentes Text-Parsing...');
  
  const result = {
    vorname: "",
    nachname: "", 
    alter: "",
    geschlecht: "",
    blutdruck: "",
    koerpertemperatur: "",
    weitere_vitalparameter: [],
    diagnose_liste: []
  };

  // Kombiniere Response und Original-Text für Analyse
  const textToAnalyze = `${responseText} ${originalText}`.toLowerCase();

  // Vorname-Erkennung (häufige deutsche Vornamen)
  const vornamen = ['max', 'anna', 'peter', 'maria', 'thomas', 'sandra', 'michael', 'julia', 'stefan', 'lisa', 'christian', 'nicole', 'andreas', 'sabine', 'markus', 'petra'];
  for (const name of vornamen) {
    if (textToAnalyze.includes(name)) {
      result.vorname = name.charAt(0).toUpperCase() + name.slice(1);
      break;
    }
  }

  // Alter-Erkennung (Zahlen oder Zahlwörter)
  const alterMatch = textToAnalyze.match(/(\d+)\s*jahr|jahr\s*(\d+)|(zwanzig|dreißig|vierzig|fünfzig|sechzig|siebzig|achtzig|neunzig|hundert)/);
  if (alterMatch) {
    const zahl = alterMatch[1] || alterMatch[2];
    if (zahl) {
      result.alter = zahl;
    } else {
      // Zahlwörter konvertieren
      const zahlwoerter = {
        'zwanzig': '20', 'dreißig': '30', 'vierzig': '40', 'fünfzig': '50',
        'sechzig': '60', 'siebzig': '70', 'achtzig': '80', 'neunzig': '90'
      };
      for (const [wort, zahl] of Object.entries(zahlwoerter)) {
        if (textToAnalyze.includes(wort)) {
          result.alter = zahl;
          break;
        }
      }
    }
  }

  // Geschlecht-Erkennung
  if (textToAnalyze.includes('männlich') || textToAnalyze.includes('mann') || textToAnalyze.includes('herr')) {
    result.geschlecht = 'männlich';
  } else if (textToAnalyze.includes('weiblich') || textToAnalyze.includes('frau') || textToAnalyze.includes('dame')) {
    result.geschlecht = 'weiblich';
  }

  // Blutdruck-Erkennung
  const blutdruckMatch = textToAnalyze.match(/(\d+)[\/\s]*(zu|über|\s)+(\d+)|(\d+)[\/](\d+)/);
  if (blutdruckMatch) {
    const systolisch = blutdruckMatch[1] || blutdruckMatch[4];
    const diastolisch = blutdruckMatch[3] || blutdruckMatch[5];
    if (systolisch && diastolisch) {
      result.blutdruck = `${systolisch}/${diastolisch} mmHg`;
    }
  }

  // Temperatur-Erkennung
  const tempMatch = textToAnalyze.match(/(\d+)[,.]?(\d+)?\s*grad|temperatur[:\s]*(\d+)[,.]?(\d+)?/);
  if (tempMatch) {
    const grad1 = tempMatch[1];
    const dezimal1 = tempMatch[2] || '0';
    const grad2 = tempMatch[3];
    const dezimal2 = tempMatch[4] || '0';
    const temp = grad1 ? `${grad1}.${dezimal1}` : `${grad2}.${dezimal2}`;
    result.koerpertemperatur = `${temp}°C`;
  }

  // Prüfe ob wir relevante Daten gefunden haben
  const hasData = result.vorname || result.alter || result.geschlecht || result.blutdruck || result.koerpertemperatur;
  
  return hasData ? result : null;
}

// Funktion für GPT-OSS:20B API-Aufruf (Ollama)
async function structureText(text) {
  const prompt = `Du bist ein medizinischer Datenextraktor. Analysiere und korrigiere den folgenden transkribierten Text von Patientenangaben. Extrahiere alle verfügbaren Informationen und korrigiere offensichtliche Transkriptionsfehler (z.B. "sechzig Jahre" → "60", "männlich" → "männlich", "Blutdruck einhundertdreißig zu achtzig" → "130/80").

WICHTIGE KATEGORIEN (immer prüfen):
- Vorname: Erkenne Vornamen, auch bei Rechtschreibfehlern
- Nachname: Erkenne Nachnamen, auch bei Rechtschreibfehlern  
- Alter: Erkenne Altersangaben in Worten oder Zahlen (z.B. "fünfzig Jahre" → "50")
- Geschlecht: männlich/weiblich/divers (auch "Mann"→"männlich", "Frau"→"weiblich")
- Blutdruck: Erkennung von Werten wie "130 zu 80" oder "hundertdreißig achtzig" → "130/80 mmHg"
- Körpertemperatur: Temperaturangaben (z.B. "achtunddreißig Grad" → "38°C")
- Weitere Vitalparameter: Puls, Sauerstoffsättigung, Atemfrequenz, etc.
- Diagnose Liste: Medizinische Diagnosen, Symptome, Beschwerden (bis zu 5 Einträge)

TEXT ZU ANALYSIEREN:
${text}

Antwort strikt als JSON-Objekt (keine zusätzlichen Erklärungen):
{
  "vorname": "",
  "nachname": "", 
  "alter": "",
  "geschlecht": "",
  "blutdruck": "",
  "koerpertemperatur": "",
  "weitere_vitalparameter": [],
  "diagnose_liste": []
}`;

  try {
    // Ollama API-Aufruf (Standard Ollama API) mit optimierten Parametern
    const response = await axios.post(process.env.GPT_OSS_ENDPOINT || 'http://localhost:11434/api/generate', {
      model: 'gpt-oss:20b',
      prompt: prompt,
      stream: false,
      options: {
        temperature: 0.1,  // Niedrigere Temperatur für präzisere Extraktion
        top_p: 0.9,        // Fokus auf wahrscheinlichste Tokens
        num_predict: 500,  // Mehr Tokens für detaillierte Antworten
        repeat_penalty: 1.1,
        stop: ['\n\n', '```'] // Stop bei Code-Blöcken oder doppelten Zeilenumbrüchen
      }
    }, {
      headers: {
        'Content-Type': 'application/json'
      },
      timeout: 30000 // 30 Sekunden Timeout
    });

    console.log('GPT Response:', response.data);

    // Verarbeite Ollama-Response
    if (response.data && response.data.response) {
      const responseText = response.data.response.trim();
      console.log('GPT Response Text:', responseText);
      
      // Versuche JSON zu parsen - mehrere Ansätze
      try {
        // 1. Direktes JSON-Parsing
        const directJson = JSON.parse(responseText);
        if (directJson && typeof directJson === 'object') {
          return directJson;
        }
      } catch (parseError) {
        console.log('Direct JSON Parse failed, trying extraction...');
      }

      try {
        // 2. Extrahiere JSON aus der Antwort (zwischen { und })
        const jsonMatch = responseText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const extractedJson = JSON.parse(jsonMatch[0]);
          console.log('Extracted JSON:', extractedJson);
          return extractedJson;
        }
      } catch (parseError) {
        console.log('JSON Extraction failed:', parseError);
      }

      // 3. Fallback: Versuche Text-Parsing für bekannte Muster
      try {
        const fallbackData = parseTextToJson(responseText, text);
        if (fallbackData) {
          console.log('Fallback parsing successful:', fallbackData);
          return fallbackData;
        }
      } catch (fallbackError) {
        console.log('Fallback parsing failed:', fallbackError);
      }
    }

    // Letzter Fallback: Versuche direkte Text-Analyse des Original-Texts
    console.log('Verwende direktes Text-Parsing des Originaltexts als letzten Fallback...');
    const directParsing = parseTextToJson('', text);
    if (directParsing) {
      return directParsing;
    }

    // Absoluter Fallback - mit Hinweis auf fehlende Daten
    return {
      vorname: "Im Text nicht erkennbar",
      nachname: "Im Text nicht erkennbar", 
      alter: "Im Text nicht erkennbar",
      geschlecht: "Im Text nicht erkennbar",
      blutdruck: "Im Text nicht erkennbar",
      koerpertemperatur: "Im Text nicht erkennbar",
      weitere_vitalparameter: ["Weitere Parameter nicht im Text identifiziert"],
      diagnose_liste: ["Transkription: " + text.substring(0, 100) + "..."]
    };
  } catch (error) {
    console.error('Fehler bei der Strukturierung:', error);
    
    // Fallback-Strukturierung basierend auf dem transkribierten Text
    return extractBasicInfo(text);
  }
}

// Verbesserte Fallback-Extraktion
function extractBasicInfo(text) {
  const result = {
    vorname: "Nicht angegeben",
    nachname: "Nicht angegeben",
    alter: "Nicht angegeben", 
    geschlecht: "Nicht angegeben",
    blutdruck: "Nicht angegeben",
    koerpertemperatur: "Nicht angegeben",
    weitere_vitalparameter: [],
    diagnose_liste: []
  };

  // Namen extrahieren
  const namePattern = /(patient|patientin)?\s*([A-Za-zäöüÄÖÜß]+)\s+([A-Za-zäöüÄÖÜß]+)/i;
  const nameMatch = text.match(namePattern);
  if (nameMatch) {
    result.vorname = nameMatch[2];
    result.nachname = nameMatch[3];
  }

  // Geschlecht bestimmen
  if (text.match(/männlich|mann|herr/i)) {
    result.geschlecht = "Männlich";
  } else if (text.match(/weiblich|frau|patientin/i)) {
    result.geschlecht = "Weiblich";
  }

  // Alter extrahieren
  const ageMatch = text.match(/(\d+)\s*jahre?\s*(alt)?/i);
  if (ageMatch) result.alter = ageMatch[1] + " Jahre";

  // Blutdruck extrahieren (verschiedene Formate)
  const bpMatch = text.match(/(\d+)\s*(zu|\/)\s*(\d+)\s*(mmhg)?/i) || 
                  text.match(/blutdruck\s*(\d+)[\s\/]+(\d+)/i);
  if (bpMatch) {
    const systolic = bpMatch[1];
    const diastolic = bpMatch[3] || bpMatch[2];
    result.blutdruck = `${systolic}/${diastolic} mmHg`;
  }

  // Temperatur extrahieren
  const tempMatch = text.match(/(\d+[.,]\d*)\s*°?\s*c(elsius)?/i) ||
                    text.match(/temperatur\s*(\d+[.,]\d*)/i);
  if (tempMatch) {
    const temp = tempMatch[1].replace(',', '.');
    result.koerpertemperatur = temp + "°C";
  }

  // Weitere Vitalparameter
  const pulseMatch = text.match(/puls|herzfrequenz[\s:]*(\d+)/i);
  if (pulseMatch) {
    result.weitere_vitalparameter.push(`Puls: ${pulseMatch[1]} bpm`);
  }

  // Diagnosen extrahieren
  const diagnosePatterns = [
    /diagnose[\s:]*([^,\.]+)/i,
    /bluthochdruck|hypertonie/i,
    /grippe|erkältung/i,
    /fieber/i,
    /normal|unauffällig/i
  ];

  diagnosePatterns.forEach(pattern => {
    const match = text.match(pattern);
    if (match && result.diagnose_liste.length < 5) {
      const diagnose = match[1] ? match[1].trim() : match[0];
      if (!result.diagnose_liste.includes(diagnose)) {
        result.diagnose_liste.push(diagnose);
      }
    }
  });

  return result;
}

// API-Endpunkte
app.post('/api/upload-audio', upload.single('audio'), async (req, res) => {
  let uploadedFilePath = null;
  
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Keine Audio-Datei hochgeladen' });
    }

    uploadedFilePath = req.file.path;
    console.log('Audio-Datei empfangen:', req.file.filename);
    
    // Schritt 1: Audio transkribieren
    const transcription = await transcribeAudio(req.file.path);
    console.log('Transkription:', transcription);

    // Schritt 2: Text strukturieren
    const structuredData = await structureText(transcription);

    res.json({
      transcription,
      structuredData
    });

  } catch (error) {
    console.error('Fehler beim Verarbeiten der Audio-Datei:', error);
    res.status(500).json({ error: 'Fehler beim Verarbeiten der Audio-Datei: ' + error.message });
  } finally {
    // Temporäre Audio-Datei immer löschen (auch bei Fehlern)
    if (uploadedFilePath) {
      try {
        if (fs.existsSync(uploadedFilePath)) {
          fs.unlinkSync(uploadedFilePath);
          console.log('Audio-Datei gelöscht:', uploadedFilePath);
        }
      } catch (deleteError) {
        console.error('Fehler beim Löschen der Audio-Datei:', deleteError);
      }
    }
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'OK', message: 'Server läuft' });
});

app.listen(PORT, () => {
  console.log(`Server läuft auf Port ${PORT}`);
  console.log(`Öffne http://localhost:${PORT} im Browser`);
  
  // Cleanup-Mechanismus: Lösche alte Audio-Dateien alle 10 Minuten
  setInterval(() => {
    const uploadsDir = './uploads';
    if (fs.existsSync(uploadsDir)) {
      const files = fs.readdirSync(uploadsDir);
      const now = Date.now();
      const maxAge = 10 * 60 * 1000; // 10 Minuten in Millisekunden
      
      files.forEach(file => {
        const filePath = path.join(uploadsDir, file);
        const stats = fs.statSync(filePath);
        
        if (now - stats.mtime.getTime() > maxAge) {
          try {
            fs.unlinkSync(filePath);
            console.log('Alte Audio-Datei automatisch gelöscht:', file);
          } catch (error) {
            console.error('Fehler beim Löschen alter Audio-Datei:', file, error);
          }
        }
      });
    }
  }, 10 * 60 * 1000); // Alle 10 Minuten ausführen
});
