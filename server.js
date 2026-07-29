// ============================================================
// SERVEUR — SE Paris
// Gère : 1) le paiement Stripe   2) le catalogue produits (base
// de données PostgreSQL)   3) l'espace administrateur (photos
// stockées de façon permanente sur Cloudinary, jusqu'à 4 par article)
// 4) la gestion des stocks   5) la newsletter (e-mails enregistrés)
// ============================================================

const express = require('express');
const cors = require('cors');
const Stripe = require('stripe');
const multer = require('multer');
const { Pool } = require('pg');
const cloudinary = require('cloudinary').v2;

const app = express();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const ADRESSE_SITE = process.env.ADRESSE_SITE || 'http://localhost:8080';
const MOT_DE_PASSE_ADMIN = process.env.ADMIN_PASSWORD || '120469';

app.use(cors({ origin: '*' }));
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('localhost')
    ? false
    : { rejectUnauthorized: false },
});

async function initialiserBaseDeDonnees() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS produits (
      id TEXT PRIMARY KEY,
      module TEXT NOT NULL,
      nom TEXT NOT NULL,
      marque TEXT DEFAULT '',
      taille TEXT DEFAULT '',
      etat TEXT DEFAULT '',
      prix NUMERIC NOT NULL,
      ancien NUMERIC DEFAULT 0,
      cat TEXT DEFAULT '',
      genre TEXT DEFAULT '',
      photo TEXT DEFAULT '',
      photo_id TEXT DEFAULT '',
      photos TEXT DEFAULT '[]',
      stock INTEGER DEFAULT 1,
      cree_le TIMESTAMP DEFAULT NOW()
    );
  `);
  await pool.query(`ALTER TABLE produits ADD COLUMN IF NOT EXISTS stock INTEGER DEFAULT 1;`);
  await pool.query(`ALTER TABLE produits ADD COLUMN IF NOT EXISTS photos TEXT DEFAULT '[]';`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS abonnes_newsletter (
      email TEXT PRIMARY KEY,
      inscrit_le TIMESTAMP DEFAULT NOW()
    );
  `);
  console.log('Base de données prête (table "produits", avec gestion du stock et photos multiples).');
}

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/^image\/(jpeg|png|webp|gif)$/.test(file.mimetype)) cb(null, true);
    else cb(new Error('Seules les images (jpg, png, webp, gif) sont acceptées.'));
  }
});

function televerserVersCloudinary(buffer) {
  return new Promise((resolve, reject) => {
    const flux = cloudinary.uploader.upload_stream(
      { folder: 'se-paris' },
      (erreur, resultat) => erreur ? reject(erreur) : resolve(resultat)
    );
    flux.end(buffer);
  });
}

function verifierMotDePasse(req, res, next) {
  const motDePasse =
