# Simulateur de panneaux solaires

Application web qui, à partir de la vue aérienne d'une maison en France :

1. **trouve les pans de toit** (pente et orientation réelles) grâce au LiDAR HD de l'IGN ;
2. **pose le maximum de panneaux** sur chaque pan (portrait, paysage ou mixte, au centimètre près) ;
3. **repère les arbres et les bâtiments voisins** et **affiche leurs ombres** à n'importe quelle date et heure (curseurs + animation) ;
4. calcule, **pour chaque panneau, le % de soleil perdu à cause des ombres**, sur l'année, l'été (avril → septembre), l'hiver (octobre → mars), par trimestre ou par mois ;
5. estime la **production en kWh** avec **micro-onduleurs** ou avec un **onduleur central (1 MPPT par pan)**.

Tout est calculé dans le navigateur, à partir de données publiques et gratuites.

## Utilisation

```bash
npm install
npm run dev        # puis ouvrir http://localhost:5173
```

1. Tapez l'adresse, puis **cliquez sur le toit de la maison**.
2. Vérifiez les pans détectés. Si besoin : **✏️ Modifier les contours** (glisser les sommets, point gris = nouveau sommet, clic droit = supprimer), **＋ Pan** pour dessiner un pan, **＋ Obstacle** pour une cheminée ou un velux. La pente et l'azimut d'un pan peuvent aussi être saisis à la main.
3. Arbres : persistants par défaut ; **cliquez sur une icône** pour rendre l'arbre caduc (mois sans feuilles et transparence réglables).
4. Choisissez le modèle de panneau et les micro-onduleurs.
5. Résultats : période, valeur affichée sur les panneaux (% de soleil perdu ou kWh), tableaux par pan et par panneau, export CSV.

Le projet est enregistré dans le navigateur et peut être exporté/importé en JSON. **Aucune adresse n'est écrite dans le dépôt.**

## Sources de données

| Donnée | Source | Accès |
|---|---|---|
| Hauteurs du toit, des arbres, des bâtiments | [LiDAR HD IGN](https://geoservices.ign.fr/lidarhd) (MNS / MNT 50 cm) | Géoplateforme, direct depuis le navigateur |
| Emprises des bâtiments | BD TOPO IGN | Géoplateforme (WFS) |
| Photo aérienne | Orthophotos IGN | Géoplateforme (WMTS) |
| Ensoleillement heure par heure | [PVGIS 5.3](https://joint-research-centre.ec.europa.eu/photovoltaic-geographical-information-system-pvgis_en) – année type, base satellite SARAH-3 (2005-2023) | voir ci-dessous |
| Relief lointain (horizon) | PVGIS | idem |

PVGIS est la référence européenne (Commission européenne) ; ses données satellite SARAH-3 sont les plus fiables disponibles gratuitement pour la France.

### Données PVGIS

PVGIS n'accepte pas les appels directs depuis une page web. L'application essaie dans l'ordre :

1. les fichiers déjà fournis dans `public/data/pvgis/` (maille de 0,05° ≈ 5 km : Peynier est inclus) ;
2. le proxy local de `npm run dev` / `npm run preview` ;
3. sinon, elle propose d'ouvrir les liens PVGIS et d'importer les fichiers JSON.

Pour ajouter une zone : `python3 tools/fetch_pvgis.py <lat> <lon>` (les coordonnées sont arrondies à 0,05°, sans révéler d'adresse).

## Méthode

- **Pans** : normales locales sur le MNS → croissance de régions planes → fusion des plans quasi coplanaires → contours simplifiés et redressés parallèlement à la gouttière. Les cheminées / chiens-assis (> 35 cm au-dessus du plan) deviennent des obstacles.
- **Arbres** : hauteur MNS − MNT hors bâtiments → sommets locaux → couronnes.
- **Calepinage** : grille de 1 cm dans le plan du toit, marge aux bords, recul aux obstacles ; tous les décalages sont testés, en portrait, paysage et mixte, et le maximum de panneaux est retenu.
- **Ombres** : lancer de rayons vers le soleil sur le modèle 3D (50 cm), pour 9 points par panneau et chaque heure de l'année type. Un arbre caduc sans feuilles laisse passer une part réglable du soleil. Le diffus est réduit selon la part de ciel masquée.
- **Rayonnement** : position du soleil NOAA, transposition Hay-Davies, albédo 0,2.
- **% de soleil perdu** = 1 − rayonnement reçu / rayonnement sans aucun masque (arbres, bâtiments et relief lointain ; détail au survol).
- **Électrique** : 3 sous-chaînes par panneau protégées par diodes bypass ; température des cellules (NOCT) ; micro-onduleurs = chaque panneau optimisé seul ; onduleur central = un MPPT par pan, panneaux du pan en série (un panneau ombré pénalise la chaîne).

Limites : les photos aériennes ne sont pas des « vraies ortho » (les toits peuvent paraître décalés par rapport au LiDAR, qui fait foi) ; les données LiDAR datent du survol IGN (arbres plus grands aujourd'hui ?) ; les caractéristiques des panneaux sont indicatives.

## Développement

```bash
npm test                 # tests unitaires
LIVE=1 npm test          # + tests sur données IGN réelles (réseau requis)
npm run build            # version statique dans dist/
```

Le workflow `.github/workflows/pages.yml` publie l'application sur GitHub Pages à chaque push sur `main` (à activer dans *Settings → Pages → Source : GitHub Actions*). En ligne, seules les zones présentes dans `public/data/pvgis/` ont l'ensoleillement automatique ; ailleurs, l'import manuel est proposé.
