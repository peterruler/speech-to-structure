const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const FormData = require('form-data');

// Python faster-whisper Integration für lokale Speech-to-Text Verarbeitung
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

// Vereinfachte Funktion für rohes Transkript - Direktes Parsing zuerst
async function structureText(text) {
  const rawTranscript = String(text).trim();
  
  console.log('=== ROHES TRANSKRIPT ===');
  console.log(rawTranscript);
  console.log('========================');
  
  // Direktes JSON-Parsing des Transkripts (immer zuerst versuchen)
  const result = parseTranscriptDirectly(rawTranscript);
  
  // Prüfe ob wir sinnvolle Daten haben
  const hasValidData = result.vorname || result.nachname || result.alter || 
                       result.geschlecht || result.blutdruck || result.koerpertemperatur ||
                       result.diagnose_liste.length > 0;
  
  if (hasValidData) {
    console.log('✅ Direktes Parsing erfolgreich:', result);
    return result;
  }
  
  console.log('⚠️ Direktes Parsing unvollständig, verwende Fallback...');
  
  // Fallback: Erweiterte GPT-OSS:20B Medizinische Diagnose (nur bei unvollständigen Daten)
  try {
    const prompt = `Analysiere folgenden medizinischen Text und extrahiere die Informationen als JSON. 
Berücksichtige insbesondere Körpertemperatur, Blutdruck, Diagnoseliste und alle Vitalparameter.
Leite aus diesen Werten eine mögliche medizinische Diagnose ab und füge sie im Feld "possibleDiagnosis" hinzu.

Text: ${rawTranscript}

Erwartetes JSON-Format:
{"vorname":"","nachname":"","alter":"","geschlecht":"","blutdruck":"","koerpertemperatur":"","weitere_vitalparameter":[],"diagnose_liste":[],"possibleDiagnosis":""}

Beispiel possibleDiagnosis:
- Bei Fieber + hohem Blutdruck: "Mögliche Infektion mit hypertensiver Krise"
- Bei niedrigem Blutdruck + Schwindel: "Hypotonie mit Kreislaufsymptomatik"
- Bei normalem Befund: "Unauffällige Vitalparameter"

JSON:`;

    const response = await axios.post(process.env.GPT_OSS_ENDPOINT || 'http://localhost:11434/api/generate', {
      model: 'gpt-oss:20b',
      prompt: prompt,
      stream: false,
      options: { temperature: 0.2, num_predict: 250 }
    }, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 15000 // 15 Sekunden für komplexere Diagnose
    });

    if (response.data?.response) {
      const jsonMatch = response.data.response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const gptResult = JSON.parse(jsonMatch[0]);
        console.log('✅ GPT-OSS:20B Fallback erfolgreich:', gptResult);
        return gptResult;
      }
    }
  } catch (gptError) {
    console.log('❌ GPT-OSS:20B Fallback fehlgeschlagen:', gptError.message);
  }

  // Letzter Fallback: Verwende direktes Parsing Ergebnis auch wenn unvollständig
  console.log('⚡ Verwende direktes Parsing Ergebnis als Final Fallback');
  return result;
}

// Direkte Parsing-Funktion für strukturierte UND natürliche Transkripte
function parseTranscriptDirectly(transcript) {
  console.log('Verwende direktes JSON-Parsing...');
  
  const result = {
    vorname: "",
    nachname: "",
    alter: "",
    geschlecht: "",
    blutdruck: "",
    koerpertemperatur: "",
    weitere_vitalparameter: [],
    diagnose_liste: [],
    possibleDiagnosis: ""
  };

  const text = transcript.toLowerCase();

  // === STRUKTURIERTES FORMAT ===
  // Extrahiere Vorname (strukturiert)
  let vornameMatch = transcript.match(/Vorname\s+([A-Za-zäöüÄÖÜß]+)/i);
  if (vornameMatch) result.vorname = vornameMatch[1];

  // Extrahiere Nachname (strukturiert)
  let nachnameMatch = transcript.match(/Nachname\s+([A-Za-zäöüÄÖÜß]+)/i);
  if (nachnameMatch) result.nachname = nachnameMatch[1];

  // === NATÜRLICHES FORMAT ===
  if (!result.vorname || !result.nachname) {
    // "mein Name ist Max Mustermann" oder "ich bin Max Mustermann"
    const nameMatch = transcript.match(/(mein name ist|ich bin|ich heiße)\s+([A-Za-zäöüÄÖÜß]+)\s+([A-Za-zäöüÄÖÜß]+)/i);
    if (nameMatch) {
      result.vorname = nameMatch[2];
      result.nachname = nameMatch[3];
    }
  }

  // === ALTER ===
  // Strukturiert: "Alter 37 Jahre"
  let alterMatch = transcript.match(/Alter\s+(\d+)/i);
  if (!alterMatch) {
    // Natürlich: "ich bin 50 Jahre alt" oder "50 Jahre alt"
    alterMatch = transcript.match(/(\d+)\s*jahre?\s*(alt)?/i);
  }
  if (alterMatch) result.alter = alterMatch[1] + " Jahre";

  // === GESCHLECHT ===
  // Strukturiert: "Geschlecht männlich"
  let geschlechtMatch = transcript.match(/Geschlecht\s+(\w+)/i);
  if (!geschlechtMatch) {
    // Natürlich: "männlich" oder "weiblich" im Text
    if (text.includes('männlich') || text.includes('mann')) {
      result.geschlecht = 'männlich';
    } else if (text.includes('weiblich') || text.includes('frau')) {
      result.geschlecht = 'weiblich';
    }
  } else {
    result.geschlecht = geschlechtMatch[1];
  }

  // === BLUTDRUCK ===
  // Beide Formate: "Blutdruck 120 zu 80" oder "Blutdruck ist 130°C zu 80°C"
  let blutdruckMatch = transcript.match(/Blutdruck\s+(?:ist\s+)?(\d+)°?C?\s*zu\s*(\d+)°?C?/i);
  if (!blutdruckMatch) {
    // Natürlich: "Mein Blutdruck ist 130 zu 80"
    blutdruckMatch = transcript.match(/blutdruck\s+(?:ist\s+)?(\d+)°?C?\s*zu\s*(\d+)°?C?/i);
  }
  if (blutdruckMatch) {
    result.blutdruck = `${blutdruckMatch[1]}/${blutdruckMatch[2]} mmHg`;
  }

  // === KÖRPERTEMPERATUR ===
  // Strukturiert: "Körpertemperatur 37°C" 
  let tempMatch = transcript.match(/Körpertemperatur\s+(\d+[,.]?\d*)°?C?/i);
  if (!tempMatch) {
    // Natürlich: "Temperatur 38,5°C" oder "38,5 Grad"
    tempMatch = transcript.match(/Temperatur\s+(\d+[,.]?\d*)°?C?/i) ||
               transcript.match(/(\d+[,.]?\d*)\s*grad/i) ||
               transcript.match(/(\d+[,.]?\d*)°C/i);
  }
  if (tempMatch) {
    const temp = tempMatch[1].replace(',', '.');
    result.koerpertemperatur = `${temp}°C`;
  }

  // === VITALPARAMETER ===
  // Puls: "Puls 60" oder "Herzfrequenz 70"
  const pulsMatch = transcript.match(/(?:Puls|Herzfrequenz)\s+(\d+)°?C?/i);
  if (pulsMatch) {
    result.weitere_vitalparameter.push(`Puls: ${pulsMatch[1]} bpm`);
  }

  // === DIAGNOSEN ===
  // Strukturiert: "Diagnose 1, Fieber"
  const strukturierteDiagnosen = transcript.match(/Diagnose\s+\d+[,:\s]*([^,]+)/gi);
  if (strukturierteDiagnosen) {
    strukturierteDiagnosen.forEach(match => {
      const diagnose = match.replace(/Diagnose\s+\d+[,:\s]*/i, '').trim();
      if (diagnose && !result.diagnose_liste.includes(diagnose)) {
        result.diagnose_liste.push(diagnose);
      }
    });
  }

  // Natürlich: "Ich habe Kopfschmerzen und Fieber"
  const symptome = ['Kopfschmerzen', 'Fieber', 'Übelkeit', 'Schwindel', 'Husten', 'Schnupfen', 'Bauchschmerzen'];
  symptome.forEach(symptom => {
    if (text.includes(symptom.toLowerCase())) {
      if (!result.diagnose_liste.includes(symptom)) {
        result.diagnose_liste.push(symptom);
      }
    }
  });

  // === MÖGLICHE DIAGNOSE GENERIEREN ===
  function generatePossibleDiagnosis() {
    const temp = parseFloat(result.koerpertemperatur);
    const blutdruckWerte = result.blutdruck.match(/(\d+)\/(\d+)/);
    const systolic = blutdruckWerte ? parseInt(blutdruckWerte[1]) : 0;
    const diastolic = blutdruckWerte ? parseInt(blutdruckWerte[2]) : 0;
    const diagnosen = result.diagnose_liste;
    
    // Diagnose-Logik basierend auf Vitalparametern
    if (temp > 38.5 && systolic > 140) {
      return "Mögliche Infektion mit hypertensiver Reaktion - Ärztliche Abklärung erforderlich";
    } else if (temp > 38.0) {
      return "Fieberhafter Infekt - Symptomatische Behandlung und Beobachtung";
    } else if (systolic > 140 || diastolic > 90) {
      return "Arterielle Hypertonie - Blutdruckkontrolle empfohlen";
    } else if (systolic < 90 || diastolic < 60) {
      return "Hypotonie - Kreislaufstabilisierung beachten";
    } else if (diagnosen.includes('Kopfschmerzen') && diagnosen.includes('Fieber')) {
      return "Grippaler Infekt mit Allgemeinsymptomatik";
    } else if (diagnosen.includes('Kopfschmerzen')) {
      return "Cephalgie - Ursachenabklärung bei Persistenz";
    } else if (diagnosen.length > 0) {
      return `Symptomkomplex: ${diagnosen.join(', ')} - Weitere Diagnostik empfohlen`;
    } else if (temp >= 36.5 && temp <= 37.5 && systolic >= 90 && systolic <= 140) {
      return "Unauffällige Vitalparameter - Gesundheitszustand stabil";
    } else {
      return "Unspezifische Symptomatik - Weitere Beobachtung empfohlen";
    }
  }
  
  // Diagnose nur generieren wenn wir medizinische Daten haben
  if (result.koerpertemperatur || result.blutdruck || result.diagnose_liste.length > 0) {
    result.possibleDiagnosis = generatePossibleDiagnosis();
  }

  console.log('Geparste Daten:', result);
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
