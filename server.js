// ============================================================
// SERVEUR — SE Paris
// Gère : 1) le paiement Stripe   2) le catalogue produits (base
// de données PostgreSQL)   3) l'espace administrateur (photos
// stockées de façon permanente sur Cloudinary)
// ============================================================
// La clé secrète Stripe, le mot de passe admin, et les identifiants
// de la base de données restent ici, côté serveur, JAMAIS visibles
// par les visiteurs du site.
// Voir GUIDE-PAIEMENT.md, GUIDE-ADMIN.md et GUIDE-BASE-DE-DONNEES.md
// pour la marche à suivre complète.
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

// ---------- Base de données PostgreSQL ----------
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
      cree_le TIMESTAMP DEFAULT NOW()
    );
  `);
  console.log('Base de données prête (table "produits").');
}

// ---------- Stockage des photos (Cloudinary, permanent) ----------
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Fichiers reçus en mémoire (pas sur le disque du serveur), puis envoyés
// directement vers Cloudinary : rien n'est perdu lors d'un redéploiement.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 Mo max
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

// ---------- Protection de l'espace admin ----------
function verifierMotDePasse(req, res, next) {
  const motDePasse = req.header('x-admin-password');
  if (motDePasse !== MOT_DE_PASSE_ADMIN) {
    return res.status(401).json({ erreur: 'Mot de passe administrateur incorrect.' });
  }
  next();
}

// ---------- Routes publiques : catalogue ----------
app.get('/produits', async (req, res) => {
  try {
    const resultat = await pool.query('SELECT * FROM produits ORDER BY cree_le DESC');
    const catalogue = { vetements: [], chaussures: [], accessoires: [] };
    resultat.rows.forEach(ligne => {
      if (!catalogue[ligne.module]) return;
      catalogue[ligne.module].push({
        id: ligne.id,
        nom: ligne.nom,
        marque: ligne.marque,
        taille: ligne.taille,
        etat: ligne.etat,
        prix: parseFloat(ligne.prix),
        ancien: parseFloat(ligne.ancien) || 0,
        cat: ligne.cat,
        genre: ligne.genre,
        photo: ligne.photo,
        date: 0
      });
    });
    res.json(catalogue);
  } catch (err) {
    console.error(err);
    res.status(500).json({ erreur: 'Impossible de charger le catalogue.' });
  }
});

// ---------- Routes admin : connexion ----------
app.post('/admin/connexion', (req, res) => {
  if (req.body.motDePasse === MOT_DE_PASSE_ADMIN) {
    res.json({ succes: true });
  } else {
    res.status(401).json({ succes: false });
  }
});

// ---------- Routes admin : ajouter un produit (avec photo) ----------
app.post('/admin/produits', verifierMotDePasse, upload.single('photo'), async (req, res) => {
  try {
    const { module, nom, marque, taille, etat, prix, ancienPrix, cat, genre } = req.body;

    if (!['vetements', 'chaussures', 'accessoires'].includes(module)) {
      return res.status(400).json({ erreur: 'Module invalide.' });
    }
    if (!nom || !prix) {
      return res.status(400).json({ erreur: 'Nom et prix sont obligatoires.' });
    }

    let urlPhoto = '';
    let idPhoto = '';
    if (req.file) {
      const resultatUpload = await televerserVersCloudinary(req.file.buffer);
      urlPhoto = resultatUpload.secure_url;
      idPhoto = resultatUpload.public_id;
    }

    const id = module[0] + Date.now();
    await pool.query(
      `INSERT INTO produits (id, module, nom, marque, taille, etat, prix, ancien, cat, genre, photo, photo_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [id, module, nom, marque || '', taille || 'Taille unique', etat || 'Bon état',
       parseFloat(prix), ancienPrix ? parseFloat(ancienPrix) : 0, cat || '', genre || '', urlPhoto, idPhoto]
    );

    res.json({
      succes: true,
      produit: { id, nom, marque, taille, etat, prix: parseFloat(prix), ancien: ancienPrix ? parseFloat(ancienPrix) : 0, cat, genre, photo: urlPhoto }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ erreur: "Erreur lors de l'ajout du produit." });
  }
});

// ---------- Routes admin : supprimer un produit ----------
app.delete('/admin/produits/:module/:id', verifierMotDePasse, async (req, res) => {
  try {
    const { id } = req.params;
    const existant = await pool.query('SELECT photo_id FROM produits WHERE id = $1', [id]);
    await pool.query('DELETE FROM produits WHERE id = $1', [id]);

    const idPhoto = existant.rows[0] && existant.rows[0].photo_id;
    if (idPhoto) {
      cloudinary.uploader.destroy(idPhoto, () => {});
    }
    res.json({ succes: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ erreur: 'Erreur lors de la suppression.' });
  }
});

// ---------- Paiement Stripe ----------
app.post('/create-checkout-session', async (req, res) => {
  try {
    const { articles } = req.body;
    if (!Array.isArray(articles) || articles.length === 0) {
      return res.status(400).json({ erreur: 'Panier vide ou invalide.' });
    }
    const line_items = articles.map(article => ({
      price_data: {
        currency: 'eur',
        product_data: { name: String(article.nom).slice(0, 250) },
        unit_amount: Math.max(50, Math.round(article.montant_centimes)),
      },
      quantity: Math.max(1, parseInt(article.quantite, 10) || 1),
    }));
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items,
      success_url: `${ADRESSE_SITE}/?paiement=succes`,
      cancel_url: `${ADRESSE_SITE}/?paiement=annule`,
      shipping_address_collection: { allowed_countries: ['FR', 'BE', 'CH', 'LU'] },
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('Erreur Stripe :', err.message);
    res.status(500).json({ erreur: 'Impossible de créer la session de paiement.' });
  }
});

app.get('/', (req, res) => {
  res.send('Serveur SE Paris — en ligne.');
});

const PORT = process.env.PORT || 4242;
initialiserBaseDeDonnees()
  .then(() => app.listen(PORT, () => console.log(`Serveur SE Paris démarré sur le port ${PORT}`)))
  .catch(err => {
    console.error('Erreur de connexion à la base de données :', err.message);
    process.exit(1);
  });
