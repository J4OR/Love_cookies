// Configuración e inicialización de Firebase (usando los SDKs desde CDN,
// así no se necesita instalar nada ni usar un empaquetador/bundler).
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

// Tu configuración de Firebase
const firebaseConfig = {
  apiKey: "AIzaSyANU16KD_0X0GD0-P-jR3kSfVn8sZTg31s",
  authDomain: "proyecto-negocio-b0625.firebaseapp.com",
  projectId: "proyecto-negocio-b0625",
  storageBucket: "proyecto-negocio-b0625.firebasestorage.app",
  messagingSenderId: "876002885728",
  appId: "1:876002885728:web:799078dc395a9a2e55c305"
};

// Inicializar Firebase y Firestore, y exportar "db" para usarlo en script.js
const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
