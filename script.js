import { db } from "./firebase-config.js";
import {
  collection, doc, addDoc, updateDoc, deleteDoc, onSnapshot, orderBy, query
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

(function(){
  const productosRef = collection(db, "productos");
  const recetasRef = collection(db, "recetas");

  let productos = []; // se llena en tiempo real desde Firestore
  let recetas = [];
  let filtroLugar = "";

  // ---------------- Unidades y cálculo de costos ----------------
  const UNIDADES = {
    g:{dim:"masa",f:1,txt:"g (gramos)"}, kg:{dim:"masa",f:1000,txt:"kg (kilos)"},
    ml:{dim:"vol",f:1,txt:"ml"}, l:{dim:"vol",f:1000,txt:"l (litros)"},
    und:{dim:"cant",f:1,txt:"und (unidades)"}
  };
  const opcionesUnidad = (sel)=> '<option value="">Unidad</option>' +
    Object.entries(UNIDADES).map(([k,u])=>`<option value="${k}"${k===sel?" selected":""}>${u.txt}</option>`).join("");
  const dinero = (n)=> "$" + Number(n||0).toLocaleString(undefined,{maximumFractionDigits:2});
  const numero = (n)=> Number(n).toLocaleString(undefined,{maximumFractionDigits:2});

  function buscarProducto(it){
    return productos.find(p=>p.id===it.productId) || productos.find(p=>p.name===it.productName);
  }
  // Lee cantidad y unidad de un ingrediente (también entiende textos viejos como "200g")
  function leerCantidad(it, prod){
    if(it.unit) return { num: parseFloat(String(it.quantity).replace(",",".")), unit: it.unit };
    const m = String(it.quantity).trim().toLowerCase().match(/^([\d.,]+)\s*([a-z]*)/);
    if(!m) return { num: NaN, unit: "" };
    const alias = {gr:"g",gramo:"g",gramos:"g",kilo:"kg",kilos:"kg",lt:"l",litro:"l",litros:"l",unidad:"und",unidades:"und",u:"und"};
    let u = m[2] || (prod && prod.unit) || "";
    u = alias[u] || u;
    return { num: parseFloat(m[1].replace(",",".")), unit: u };
  }
  // Costo de un ingrediente = precio del paquete x (cantidad usada / cantidad del paquete)
  function costoItem(it){
    const prod = buscarProducto(it);
    if(!prod) return { ok:false, motivo:"el producto ya no existe" };
    const pu = UNIDADES[prod.unit];
    if(!pu) return { ok:false, motivo:"al producto le falta la unidad (edítalo)" };
    const paquete = parseFloat(prod.quantity);
    if(!(paquete>0)) return { ok:false, motivo:"el producto no tiene una cantidad válida" };
    const q = leerCantidad(it, prod);
    const iu = UNIDADES[q.unit];
    if(!iu || !(q.num>=0)) return { ok:false, motivo:"cantidad o unidad inválida" };
    if(iu.dim!==pu.dim) return { ok:false, motivo:`no se puede convertir ${q.unit} a ${prod.unit}` };
    const base = q.num*iu.f;
    return { ok:true, base, dim:iu.dim, nombre:prod.name,
             costo:(Number(prod.price)||0)*base/(paquete*pu.f) };
  }
  function costoReceta(r){
    const items = r.items.map(it=>({ it, c: costoItem(it) }));
    const total = items.reduce((t,x)=> t + (x.c.ok ? x.c.costo : 0), 0);
    return { items, total, fallos: items.filter(x=>!x.c.ok).length };
  }
  // Presentaciones de compra de un producto: la principal + las otras (todas en la misma unidad)
  function presentaciones(prod){
    const u = UNIDADES[prod.unit];
    if(!u) return [];
    return [{ quantity: parseFloat(prod.quantity), price: prod.price }, ...(prod.opciones||[])]
      .map(o=>({ quantity:Number(o.quantity), price:Number(o.price)||0, qBase:Number(o.quantity)*u.f }))
      .filter(o=>o.qBase>0);
  }
  // Combinación más barata de presentaciones que cubre "falta" (en g, ml o und)
  function mejorCompra(falta, ops){
    const lineas0 = ops.map(o=>({ n:0, quantity:o.quantity, price:o.price }));
    if(falta<=0.01 || ops.length===0) return { total:0, cubierto:0, lineas:lineas0 };
    const max = ops.map(o=>Math.ceil(falta/o.qBase - 1e-9));
    if(max.reduce((t,m)=>t*(m+1), 1) > 200000){ // demasiadas combinaciones: se usa la presentación más barata por unidad
      let k = 0;
      ops.forEach((o,i)=>{ if(o.price/o.qBase < ops[k].price/ops[k].qBase) k = i; });
      return { total:max[k]*ops[k].price, cubierto:max[k]*ops[k].qBase,
               lineas: ops.map((o,i)=>({ n:i===k?max[k]:0, quantity:o.quantity, price:o.price })) };
    }
    let mejor = null;
    const cuentas = new Array(ops.length).fill(0);
    (function rec(i, cubierto, costo){
      if(mejor && costo>mejor.total+1e-9) return;
      if(i===ops.length){
        if(cubierto>=falta-0.01 && (!mejor || costo<mejor.total-1e-9 ||
           (Math.abs(costo-mejor.total)<=1e-9 && cubierto<mejor.cubierto))){
          mejor = { total:costo, cubierto, cuentas:[...cuentas] };
        }
        return;
      }
      for(let c=0; c<=max[i]; c++){
        cuentas[i] = c;
        rec(i+1, cubierto + c*ops[i].qBase, costo + c*ops[i].price);
      }
      cuentas[i] = 0;
    })(0, 0, 0);
    return { total:mejor.total, cubierto:mejor.cubierto,
             lineas: ops.map((o,i)=>({ n:mejor.cuentas[i], quantity:o.quantity, price:o.price })) };
  }
  // Filas de "otras presentaciones" (cantidad + precio) para el formulario y la ventana de editar
  function filaOpcionHtml(o){
    return `<div class="form-row opcion-row">
      <input type="text" class="o-cant" placeholder="Cantidad (12 o 1/2)" value="${o ? escapeHtml(String(o.quantity)) : ""}">
      <input type="number" step="any" min="0" inputmode="decimal" class="o-precio" placeholder="Precio (opcional)" value="${o ? escapeHtml(String(o.price)) : ""}">
      <button type="button" class="small danger o-quitar">✕</button>
    </div>`;
  }
  // Interpreta la cantidad de una presentación: número normal (250), fracción de la principal (1/2, 1/4, 3/4),
  // número mixto (1 1/2) o símbolos (½, ¼, ¾). Las fracciones se calculan sobre la presentación principal.
  function parseCantidadOpcion(txt, baseQty){
    let t = String(txt).trim().replace(",", ".");
    const simb = { "½":0.5, "¼":0.25, "¾":0.75 };
    let frac = null, m;
    if(simb[t]!==undefined) frac = simb[t];
    else {
      t = t.replace(/[½¼¾]/g, c=>" "+simb[c]).trim();
      if((m = t.match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/)) && parseFloat(m[2])>0) frac = parseFloat(m[1]) / parseFloat(m[2]);
      else if((m = t.match(/^(\d+)\s+(\d+)\s*\/\s*(\d+)$/)) && parseFloat(m[3])>0) frac = parseInt(m[1]) + parseInt(m[2])/parseFloat(m[3]);
      else if((m = t.match(/^(\d+)\s+(0?\.\d+)$/))) frac = parseInt(m[1]) + parseFloat(m[2]);
      else if(/^\d*\.?\d+$/.test(t)) return { quantity: parseFloat(t) > 0 ? parseFloat(t) : null, frac: null };
    }
    if(frac===null || !(frac>0) || !(baseQty>0)) return { quantity: null, frac: null };
    return { quantity: frac * baseQty, frac };
  }
  function leerOpciones(cont, baseQty, basePrice){
    return [...cont.querySelectorAll(".opcion-row")].map(r=>{
      const c = parseCantidadOpcion(r.querySelector(".o-cant").value, baseQty);
      let price = parseFloat(r.querySelector(".o-precio").value);
      // fracción sin precio: se calcula proporcional al precio de la presentación principal
      if(isNaN(price) && c.frac && basePrice>0) price = Math.round(c.frac * basePrice * 100) / 100;
      return { quantity: c.quantity, price };
    }).filter(o=>o.quantity>0 && o.price>=0);
  }
  function actualizarPreciosSugeridos(cont, cantidadBase, precioBase){
    const baseQty = parseFloat(cantidadBase.value);
    const basePrice = parseFloat(precioBase.value);
    cont.querySelectorAll(".opcion-row").forEach(r=>{
      const campoCantidad = r.querySelector(".o-cant");
      const campoPrecio = r.querySelector(".o-precio");
      const c = parseCantidadOpcion(campoCantidad.value, baseQty);
      campoPrecio.placeholder = "Precio (opcional)";
      if(!campoPrecio.value.trim() && c.frac && basePrice>0){
        const sugerido = Math.round(c.frac * basePrice * 100) / 100;
        campoPrecio.placeholder = `Precio (sugerido: ${dinero(sugerido)})`;
      }
    });
  }
  function enlazarOpciones(cont, botonAgregar, opciones, cantidadBase, precioBase){
    cont.innerHTML = (opciones||[]).map(filaOpcionHtml).join("");
    const actualizar = ()=> actualizarPreciosSugeridos(cont, cantidadBase, precioBase);
    botonAgregar.onclick = ()=>{
      cont.insertAdjacentHTML("beforeend", filaOpcionHtml());
      actualizar();
    };
    cont.addEventListener("input", actualizar);
    cont.onclick = (e)=>{ if(e.target.classList.contains("o-quitar")) e.target.closest(".opcion-row").remove(); };
    cantidadBase.addEventListener("input", actualizar);
    precioBase.addEventListener("input", actualizar);
    actualizar();
  }
  const textoOpciones = (p)=> (p.opciones||[]).map(o=>`${numero(o.quantity)} ${p.unit} a ${dinero(o.price)}`).join(", ");

  function cantidadBonita(base, dim){
    if(dim==="masa") return base>=1000 ? numero(base/1000)+" kg" : numero(base)+" g";
    if(dim==="vol") return base>=1000 ? numero(base/1000)+" l" : numero(base)+" ml";
    return numero(base)+" und";
  }

  // ---------------- Ventana emergente (modal) genérica ----------------
  const modalOverlay = document.getElementById("modal-overlay");
  const modalBox = document.getElementById("modal-box");

  function abrirModal(html){
    modalBox.innerHTML = html;
    modalOverlay.classList.remove("hidden");
  }
  function cerrarModal(){
    modalOverlay.classList.add("hidden");
    modalBox.innerHTML = "";
  }
  modalOverlay.addEventListener("click", (e)=>{
    if(e.target === modalOverlay) cerrarModal();
  });

  function confirmarAccion(mensaje, textoBoton, onConfirmar){
    abrirModal(`
      <h3>Confirmar</h3>
      <p>${escapeHtml(mensaje)}</p>
      <div class="modal-actions">
        <button class="secondary" id="modal-cancelar">Cancelar</button>
        <button class="danger" id="modal-confirmar">${escapeHtml(textoBoton)}</button>
      </div>
    `);
    document.getElementById("modal-cancelar").addEventListener("click", cerrarModal);
    document.getElementById("modal-confirmar").addEventListener("click", async ()=>{
      cerrarModal();
      await onConfirmar();
    });
  }

  // ---- Tabs ----
  document.querySelectorAll(".tab").forEach(t=>{
    t.addEventListener("click", ()=>{
      document.querySelectorAll(".tab").forEach(x=>x.classList.remove("active"));
      document.querySelectorAll(".panel").forEach(x=>x.classList.remove("active"));
      t.classList.add("active");
      document.getElementById("panel-"+t.dataset.tab).classList.add("active");
    });
  });

  // ---- Productos ----
  const elNombre = document.getElementById("p-nombre");
  const elPrecio = document.getElementById("p-precio");
  const elCantidad = document.getElementById("p-cantidad");
  const elLugar = document.getElementById("p-lugar");
  const btnGuardar = document.getElementById("p-guardar");
  const elFiltroLugar = document.getElementById("p-filtro-lugar");
  const elBuscarProducto = document.getElementById("p-buscar");
  let filtroNombreProductos = "";

  elFiltroLugar.addEventListener("change", ()=>{
    filtroLugar = elFiltroLugar.value;
    renderProductos();
  });
  elBuscarProducto.addEventListener("input", ()=>{
    filtroNombreProductos = elBuscarProducto.value.trim().toLocaleLowerCase();
    renderProductos();
  });

  // Escucha en tiempo real: cada vez que cambie algo en "productos" en Firestore,
  // esta función se vuelve a ejecutar sola y refresca la pantalla.
  onSnapshot(query(productosRef, orderBy("name")), (snapshot)=>{
    productos = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    renderProductos();
    renderRecetas(); // el selector de productos dentro de recetas también depende de esto
  }, (error)=>{
    console.error("Error leyendo productos:", error);
    document.getElementById("lista-productos").innerHTML =
      '<div class="empty">No se pudo conectar con la base de datos. Revisa la consola.</div>';
  });

  function actualizarOpcionesFiltro(){
    const lugares = [...new Set(productos.map(p=>p.place).filter(l=>l && l.trim()))].sort((a,b)=>a.localeCompare(b));
    const valorActual = elFiltroLugar.value;
    elFiltroLugar.innerHTML = '<option value="">Todos los lugares</option>' +
      lugares.map(l=>`<option value="${escapeHtml(l)}">${escapeHtml(l)}</option>`).join("");
    if(lugares.includes(valorActual)) elFiltroLugar.value = valorActual;
    else filtroLugar = "";
  }

  function renderProductos(){
    actualizarOpcionesFiltro();
    const cont = document.getElementById("lista-productos");
    const productosFiltrados = productos.filter(p=>
      (!filtroLugar || p.place === filtroLugar) &&
      (!filtroNombreProductos || String(p.name||"").toLocaleLowerCase().startsWith(filtroNombreProductos))
    );
    if(productosFiltrados.length===0){
      cont.innerHTML = '<div class="empty">'+
        (productos.length===0 ? 'Aún no hay productos agregados.' : 'No hay productos que coincidan con la búsqueda y el lugar.')
        +'</div>';
      return;
    }
    cont.innerHTML = '<div class="card overflow-x">' + productosFiltrados.map(p=>`
      <div class="item">
        <div class="item-info">
          <b>${escapeHtml(p.name)}</b> — ${dinero(p.price)} · ${escapeHtml(String(p.quantity||""))} ${escapeHtml(p.unit||"")}
          <div class="muted">${escapeHtml(p.place||"")}</div>
          ${(p.opciones||[]).length ? `<div class="muted">Otras presentaciones: ${escapeHtml(textoOpciones(p))}</div>` : ""}
        </div>
        <div class="item-actions">
          <button class="small secondary" data-edit="${p.id}">Editar</button>
          <button class="small danger" data-del="${p.id}">Eliminar</button>
        </div>
      </div>`).join("") + '</div>';

    cont.querySelectorAll("[data-edit]").forEach(b=>{
      b.addEventListener("click", ()=> abrirModalEditarProducto(b.dataset.edit));
    });
    cont.querySelectorAll("[data-del]").forEach(b=>{
      b.addEventListener("click", ()=> {
        const p = productos.find(x=>x.id===b.dataset.del);
        confirmarAccion(`¿Eliminar "${p.name}"?`, "Eliminar", async ()=>{
          try{ await deleteDoc(doc(db, "productos", p.id)); }
          catch(e){ console.error(e); alert("No se pudo eliminar el producto."); }
        });
      });
    });
  }

  function abrirModalEditarProducto(id){
    const p = productos.find(x=>x.id===id);
    if(!p) return;
    abrirModal(`
      <h3>Editar producto</h3>
      <div class="form-row"><input id="m-nombre" placeholder="Nombre del producto"></div>
      <div class="form-row"><input id="m-precio" type="number" step="0.01" placeholder="Precio"></div>
      <div class="form-row"><input id="m-cantidad" type="number" step="any" inputmode="decimal" placeholder="Cantidad del paquete"><select id="m-unidad"></select></div>
      <div class="form-row"><input id="m-lugar" placeholder="Lugar de compra"></div>
      <div class="muted" style="margin:8px 0 4px">Otras presentaciones (misma unidad). Para 1/2 o 1/4 del paquete principal, deja el precio vacío y se calculará proporcionalmente.</div>
      <div id="m-opciones"></div>
      <div class="form-row"><button type="button" class="small secondary" id="m-add-opcion">+ Agregar presentación</button></div>
      <div class="modal-actions">
        <button class="secondary" id="modal-cancelar">Cancelar</button>
        <button id="modal-guardar">Guardar cambios</button>
      </div>
    `);
    document.getElementById("m-nombre").value = p.name || "";
    document.getElementById("m-precio").value = p.price || 0;
    document.getElementById("m-cantidad").value = p.quantity || "";
    document.getElementById("m-unidad").innerHTML = opcionesUnidad(p.unit || "");
    enlazarOpciones(document.getElementById("m-opciones"), document.getElementById("m-add-opcion"), p.opciones,
      document.getElementById("m-cantidad"), document.getElementById("m-precio"));
    document.getElementById("m-lugar").value = p.place || "";
    document.getElementById("modal-cancelar").addEventListener("click", cerrarModal);
    document.getElementById("modal-guardar").addEventListener("click", async ()=>{
      const name = document.getElementById("m-nombre").value.trim();
      if(!name){ alert("Escribe el nombre del producto."); return; }
      const data = {
        name,
        price: parseFloat(document.getElementById("m-precio").value)||0,
        quantity: parseFloat(document.getElementById("m-cantidad").value)||0,
        unit: document.getElementById("m-unidad").value,
        opciones: leerOpciones(document.getElementById("m-opciones"), parseFloat(document.getElementById("m-cantidad").value)||0, parseFloat(document.getElementById("m-precio").value)||0),
        place: document.getElementById("m-lugar").value.trim()
      };
      try{
        await updateDoc(doc(db, "productos", id), data);
        cerrarModal();
      }catch(e){
        console.error(e);
        alert("No se pudo guardar el producto.");
      }
    });
  }

  btnGuardar.addEventListener("click", async ()=>{
    const name = elNombre.value.trim();
    if(!name){ alert("Escribe el nombre del producto."); return; }
    const data = {
      name,
      price: parseFloat(elPrecio.value)||0,
      quantity: parseFloat(elCantidad.value)||0,
      unit: document.getElementById("p-unidad").value,
      opciones: leerOpciones(document.getElementById("p-opciones"), parseFloat(elCantidad.value)||0, parseFloat(elPrecio.value)||0),
      place: elLugar.value.trim()
    };
    btnGuardar.disabled = true;
    try{
      await addDoc(productosRef, data);
      elNombre.value=elPrecio.value=elCantidad.value=elLugar.value="";
      document.getElementById("p-opciones").innerHTML = "";
    }catch(e){
      console.error(e);
      alert("No se pudo guardar el producto.");
    }finally{
      btnGuardar.disabled = false;
    }
  });

  // ---- Recetas ----
  const elRecNombre = document.getElementById("r-nombre");
  const elRecRinde = document.getElementById("r-rinde");
  const elCReceta = document.getElementById("c-receta");
  const elCGalletas = document.getElementById("c-galletas");
  document.getElementById("p-unidad").innerHTML = opcionesUnidad("g");
  enlazarOpciones(document.getElementById("p-opciones"), document.getElementById("p-add-opcion"), [],
    elCantidad, elPrecio);

  document.getElementById("r-nueva").addEventListener("click", async ()=>{
    const name = elRecNombre.value.trim();
    if(!name){ alert("Escribe el nombre de la receta."); return; }
    try{
      await addDoc(recetasRef, { name, rinde: parseInt(elRecRinde.value)||0, items: [] });
      elRecNombre.value = elRecRinde.value = "";
    }catch(e){
      console.error(e);
      alert("No se pudo crear la receta.");
    }
  });

  onSnapshot(query(recetasRef, orderBy("name")), (snapshot)=>{
    recetas = snapshot.docs.map(d => ({ id: d.id, ...d.data(), items: d.data().items || [] }));
    renderRecetas();
  }, (error)=>{
    console.error("Error leyendo recetas:", error);
    document.getElementById("lista-recetas").innerHTML =
      '<div class="empty">No se pudo conectar con la base de datos. Revisa la consola.</div>';
  });

  function renderRecetas(){
    const cont = document.getElementById("lista-recetas");
    renderCalcular();
    renderLista();
    if(recetas.length===0){
      cont.innerHTML = '<div class="empty">Aún no hay recetas creadas.</div>';
      return;
    }
    cont.innerHTML = recetas.map(r=>{
      const cr = costoReceta(r);
      return `
      <div class="card" data-recid="${r.id}">
        <div class="item">
          <div class="item-info"><b>${escapeHtml(r.name)}</b>
            <div class="muted">${r.rinde>0 ? "Rinde "+r.rinde+" galletas" : "Sin definir cuántas galletas rinde"}</div>
          </div>
          <div class="item-actions">
            <button class="small secondary" data-renombrar="${r.id}">Editar</button>
            <button class="small danger" data-delrec="${r.id}">Eliminar receta</button>
          </div>
        </div>
        <ul class="recipe-items">
          ${cr.items.length===0 ? '<li class="muted">Sin productos agregados</li>' :
            cr.items.map(({it,c},i)=>{
              const prod = buscarProducto(it);
              const q = leerCantidad(it, prod);
              const cant = isNaN(q.num) ? it.quantity : numero(q.num);
              return `
              <li>
                <span>${escapeHtml(prod ? prod.name : it.productName)} — ${escapeHtml(String(cant))} ${escapeHtml(q.unit)}
                  <div class="muted">${c.ok ? dinero(c.costo) : '<span class="warn">⚠ '+escapeHtml(c.motivo)+'</span>'}</div>
                </span>
                <span>
                  <button class="small secondary" data-edititem="${r.id}|${i}">Editar</button>
                  <button class="small danger" data-delitem="${r.id}|${i}">✕</button>
                </span>
              </li>`;}).join("")}
        </ul>
        <div class="summary">
          <div>Costo total de la receta: <b>${dinero(cr.total)}</b></div>
          <div>${r.rinde>0 ? "Costo por galleta: <b>"+dinero(cr.total/r.rinde)+"</b>" : "Define cuántas galletas rinde (botón Editar) para ver el costo por galleta."}</div>
          ${cr.fallos ? `<div class="warn">⚠ ${cr.fallos} ingrediente(s) sin calcular, no están en el total.</div>` : ""}
        </div>
        <div class="form-row">
          <select data-productselect="${r.id}">
            <option value="">Selecciona un producto</option>
            ${productos.map(p=>`<option value="${p.id}">${escapeHtml(p.name)}</option>`).join("")}
          </select>
          <input type="number" step="any" min="0" inputmode="decimal" placeholder="Cantidad" data-cantidad-input="${r.id}" style="max-width:110px">
          <select data-unidad-select="${r.id}" style="max-width:130px">${opcionesUnidad("")}</select>
          <button class="small" data-agregaritem="${r.id}">Agregar</button>
        </div>
      </div>`;}).join("");

    // al elegir un producto, se sugiere su unidad
    cont.querySelectorAll("[data-productselect]").forEach(s=>{
      s.addEventListener("change", ()=>{
        const p = productos.find(x=>x.id===s.value);
        cont.querySelector(`[data-unidad-select="${s.dataset.productselect}"]`).value = p ? (p.unit||"") : "";
      });
    });
    cont.querySelectorAll("[data-delrec]").forEach(b=>{
      b.addEventListener("click", ()=>{
        const r = recetas.find(x=>x.id===b.dataset.delrec);
        confirmarAccion(`¿Eliminar la receta "${r.name}" completa?`, "Eliminar", async ()=>{
          try{ await deleteDoc(doc(db, "recetas", r.id)); }
          catch(e){ console.error(e); alert("No se pudo eliminar la receta."); }
        });
      });
    });
    cont.querySelectorAll("[data-renombrar]").forEach(b=>{
      b.addEventListener("click", ()=> abrirModalEditarReceta(b.dataset.renombrar));
    });
    cont.querySelectorAll("[data-agregaritem]").forEach(b=>{
      b.addEventListener("click", async ()=>{
        const recId = b.dataset.agregaritem;
        const prodId = cont.querySelector(`[data-productselect="${recId}"]`).value;
        const cantidad = parseFloat(cont.querySelector(`[data-cantidad-input="${recId}"]`).value);
        const unit = cont.querySelector(`[data-unidad-select="${recId}"]`).value;
        if(!prodId){ alert("Selecciona un producto."); return; }
        if(!(cantidad>0)){ alert("Escribe una cantidad mayor a 0."); return; }
        if(!unit){ alert("Elige la unidad."); return; }
        const prod = productos.find(p=>p.id===prodId);
        const r = recetas.find(x=>x.id===recId);
        const nuevosItems = [...r.items, { productId: prod.id, productName: prod.name, quantity: cantidad, unit }];
        try{ await updateDoc(doc(db, "recetas", recId), { items: nuevosItems }); }
        catch(e){ console.error(e); alert("No se pudo agregar el ingrediente."); }
      });
    });
    cont.querySelectorAll("[data-delitem]").forEach(b=>{
      b.addEventListener("click", ()=>{
        const [recId, idx] = b.dataset.delitem.split("|");
        const r = recetas.find(x=>x.id===recId);
        const item = r.items[Number(idx)];
        const prod = buscarProducto(item);
        confirmarAccion(`¿Quitar "${prod ? prod.name : item.productName}" de la receta?`, "Quitar", async ()=>{
          const nuevosItems = r.items.filter((_,i)=> i !== Number(idx));
          try{ await updateDoc(doc(db, "recetas", recId), { items: nuevosItems }); }
          catch(e){ console.error(e); alert("No se pudo eliminar el ingrediente."); }
        });
      });
    });
    cont.querySelectorAll("[data-edititem]").forEach(b=>{
      b.addEventListener("click", ()=>{
        const [recId, idx] = b.dataset.edititem.split("|");
        abrirModalEditarItem(recId, Number(idx));
      });
    });
  }

  function abrirModalEditarReceta(recId){
    const r = recetas.find(x=>x.id===recId);
    if(!r) return;
    abrirModal(`
      <h3>Editar receta</h3>
      <div class="form-row"><input id="m-rec-nombre" placeholder="Nombre de la receta"></div>
      <div class="form-row"><input id="m-rec-rinde" type="number" min="1" step="1" inputmode="numeric" placeholder="Galletas que rinde"></div>
      <div class="modal-actions">
        <button class="secondary" id="modal-cancelar">Cancelar</button>
        <button id="modal-guardar">Guardar</button>
      </div>
    `);
    document.getElementById("m-rec-nombre").value = r.name;
    document.getElementById("m-rec-rinde").value = r.rinde || "";
    document.getElementById("modal-cancelar").addEventListener("click", cerrarModal);
    document.getElementById("modal-guardar").addEventListener("click", async ()=>{
      const nuevo = document.getElementById("m-rec-nombre").value.trim();
      if(!nuevo){ alert("Escribe un nombre."); return; }
      try{
        await updateDoc(doc(db, "recetas", recId), {
          name: nuevo, rinde: parseInt(document.getElementById("m-rec-rinde").value)||0
        });
        cerrarModal();
      }catch(e){
        console.error(e);
        alert("No se pudo guardar la receta.");
      }
    });
  }

  function abrirModalEditarItem(recId, idx){
    const r = recetas.find(x=>x.id===recId);
    if(!r) return;
    const item = r.items[idx];
    if(!item) return;
    const prod = buscarProducto(item);
    const q = leerCantidad(item, prod);
    abrirModal(`
      <h3>Editar ingrediente</h3>
      <p class="muted">${escapeHtml(prod ? prod.name : item.productName)}</p>
      <div class="form-row">
        <input id="m-item-cantidad" type="number" step="any" min="0" inputmode="decimal" placeholder="Cantidad">
        <select id="m-item-unidad"></select>
      </div>
      <div class="modal-actions">
        <button class="secondary" id="modal-cancelar">Cancelar</button>
        <button id="modal-guardar">Guardar</button>
      </div>
    `);
    document.getElementById("m-item-cantidad").value = isNaN(q.num) ? "" : q.num;
    document.getElementById("m-item-unidad").innerHTML = opcionesUnidad(q.unit);
    document.getElementById("modal-cancelar").addEventListener("click", cerrarModal);
    document.getElementById("modal-guardar").addEventListener("click", async ()=>{
      const cantidad = parseFloat(document.getElementById("m-item-cantidad").value);
      const unit = document.getElementById("m-item-unidad").value;
      if(!(cantidad>0)){ alert("Escribe una cantidad mayor a 0."); return; }
      if(!unit){ alert("Elige la unidad."); return; }
      const nuevosItems = r.items.map((it,i)=> i===idx
        ? { ...it, productId: prod ? prod.id : it.productId, quantity: cantidad, unit } : it);
      try{
        await updateDoc(doc(db, "recetas", recId), { items: nuevosItems });
        cerrarModal();
      }catch(e){
        console.error(e);
        alert("No se pudo editar el ingrediente.");
      }
    });
  }

  // ---- Calcular: varias recetas -> detalle de compra (paquetes y precio) ----
  let calcLista = [];      // [{recId, galletas}]
  let calcMostrar = false; // true cuando ya se pulsó "Calcular"
  const calcTengo = new Map(); // productId -> cantidad que ya tiene (en g, ml o und)
  const elCAgregar = document.getElementById("c-agregar");

  elCAgregar.addEventListener("click", ()=>{
    const recId = elCReceta.value;
    const n = parseInt(elCGalletas.value);
    if(!recId){ alert("Elige una receta."); return; }
    if(!(n>0)){ alert("Escribe cuántas galletas quieres hacer."); return; }
    const ya = calcLista.find(x=>x.recId===recId);
    if(ya) ya.galletas += n; else calcLista.push({ recId, galletas: n });
    elCGalletas.value = "";
    calcMostrar = false; calcTengo.clear();
    renderCalcular();
  });

  // Suma lo que se necesita de cada producto entre todas las recetas y lo pasa a paquetes completos
  function calcularCompra(entradas){
    const avisos = [];
    const acum = new Map();
    let usado = 0;
    entradas.forEach(({r, galletas})=>{
      if(!(r.rinde>0)){
        avisos.push(`"${r.name}" no tiene definido cuántas galletas rinde (edítala en Recetas); no se incluyó.`);
        return;
      }
      const factor = galletas / r.rinde;
      costoReceta(r).items.forEach(({it,c})=>{
        if(!c.ok){ avisos.push(`${r.name}: ${it.productName||"ingrediente"} — ${c.motivo}`); return; }
        const prod = buscarProducto(it);
        const a = acum.get(prod.id) || { prod, dim:c.dim, base:0 };
        a.base += c.base * factor;
        acum.set(prod.id, a);
        usado += c.costo * factor;
      });
    });
    const productosCompra = [...acum.values()].map(a=>{
      const paqBase = parseFloat(a.prod.quantity) * UNIDADES[a.prod.unit].f;
      const paquetes = Math.max(0, Math.ceil(a.base/paqBase - 1e-9));
      return { ...a, paqBase, paquetes, sobra: paquetes*paqBase - a.base,
               total: paquetes * (Number(a.prod.price)||0),
               usadoProd: a.base/paqBase * (Number(a.prod.price)||0) };
    }).sort((x,y)=> x.prod.name.localeCompare(y.prod.name));
    const totalCompra = productosCompra.reduce((t,f)=>t+f.total, 0);
    return { productosCompra, totalCompra, usado, avisos };
  }

  function renderCalcular(){
    const prev = elCReceta.value;
    elCReceta.innerHTML = '<option value="">Elige una receta</option>' +
      recetas.map(r=>`<option value="${r.id}">${escapeHtml(r.name)}</option>`).join("");
    if(recetas.some(r=>r.id===prev)) elCReceta.value = prev;

    const cl = document.getElementById("c-lista");
    const cont = document.getElementById("c-resultado");
    const filas = calcLista.map((x,i)=>({ x, i, r: recetas.find(r=>r.id===x.recId) })).filter(f=>f.r);
    if(filas.length===0){
      cl.innerHTML = '<div class="empty">Agrega las recetas que vas a hacer y cuántas galletas de cada una.</div>';
      cont.innerHTML = "";
      return;
    }
    cl.innerHTML = `<div class="card">
      ${filas.map(({x,i,r})=>`
        <div class="item">
          <div class="item-info"><b>${escapeHtml(r.name)}</b> — ${numero(x.galletas)} galletas</div>
          <div class="item-actions"><button class="small danger" data-c-quitar="${i}">Quitar</button></div>
        </div>`).join("")}
      <div class="form-row" style="margin-top:10px"><button id="c-calcular" style="width:100%">Calcular</button></div>
    </div>`;
    cl.querySelectorAll("[data-c-quitar]").forEach(b=>{
      b.addEventListener("click", ()=>{
        calcLista.splice(Number(b.dataset.cQuitar), 1);
        calcMostrar = false; calcTengo.clear();
        renderCalcular();
      });
    });
    document.getElementById("c-calcular").addEventListener("click", ()=>{
      calcMostrar = true;
      renderCalcular();
    });

    if(!calcMostrar){ cont.innerHTML = ""; return; }
    const res = calcularCompra(filas.map(f=>({ r:f.r, galletas:f.x.galletas })));
    // Se resta lo que el usuario ya tiene y se recalculan los paquetes con lo que falta
    const EPS = 0.01; // tolerancia en g/ml/und
    const filasCalc = res.productosCompra.map(f=>{
      const tengo = calcTengo.get(f.prod.id) || 0;
      const falta = Math.max(0, f.base - tengo);
      const precio = Number(f.prod.price)||0;
      const compra = mejorCompra(falta<=EPS ? 0 : falta, presentaciones(f.prod));
      const paquetesComprar = compra.lineas.reduce((t,l)=>t+l.n, 0);
      return { ...f, tengo, falta, compra, paquetesComprar,
               sobraComprar: compra.cubierto - falta,
               totalComprar: compra.total,
               usadoComprar: falta/f.paqBase*precio };
    });
    const pendientes = filasCalc.filter(f=>f.falta>EPS);
    const yaTengo = filasCalc.filter(f=>f.tengo>0 && f.falta<=EPS);
    const totalPagar = pendientes.reduce((t,f)=>t+f.totalComprar, 0);
    const usado = pendientes.reduce((t,f)=>t+f.usadoComprar, 0);
    cont.innerHTML = `
      <div class="card">
        <div class="total-box">
          <div class="muted">Total a pagar comprando paquetes completos</div>
          <div class="big">${dinero(totalPagar)}</div>
          <div class="muted">Costo de lo que realmente usas: ${dinero(usado)}</div>
        </div>
        <div class="muted" style="margin:10px 0 4px">Lo que necesitas comprar:</div>
        <ul class="recipe-items">
          ${res.productosCompra.length===0 ? '<li class="muted">No hay ingredientes para calcular.</li>' :
            pendientes.length===0 ? '<li class="muted">Ya tienes todo lo necesario 🎉</li>' :
            pendientes.map(f=>`
            <li>
              <span><b>${escapeHtml(f.prod.name)}</b>: necesitas
                ${f.compra.lineas.filter(l=>l.n>0).map(l=>`x${l.n} de ${numero(l.quantity)} ${escapeHtml(f.prod.unit)} <span class="muted">(${dinero(l.price)} c/u)</span>`).join(" + ")}
                <div class="muted">Necesitas ${cantidadBonita(f.base, f.dim)}${f.tengo>0 ? " · tienes "+cantidadBonita(f.tengo, f.dim)+" · te faltan "+cantidadBonita(f.falta, f.dim) : ""} · sobra ${cantidadBonita(Math.max(0,f.sobraComprar), f.dim)}${f.prod.place ? " · Comprar en: "+escapeHtml(f.prod.place) : ""}</div>
              </span>
              <span style="text-align:right"><b>${dinero(f.totalComprar)}</b>
                <div><button class="small secondary" data-yatengo="${f.prod.id}">${f.tengo>0 ? "Cambiar lo que tengo" : "Ya lo tengo"}</button></div>
              </span>
            </li>`).join("")}
        </ul>
        ${yaTengo.length ? `
          <div class="muted" style="margin:10px 0 4px">Ya los tienes (no cuentan en el total):</div>
          <ul class="recipe-items">
            ${yaTengo.map(f=>`
              <li>
                <span>${escapeHtml(f.prod.name)} — tienes ${cantidadBonita(f.tengo, f.dim)} (necesitas ${cantidadBonita(f.base, f.dim)})</span>
                <span><button class="small secondary" data-deshacer="${f.prod.id}">Deshacer</button></span>
              </li>`).join("")}
          </ul>` : ""}
        ${res.avisos.map(a=>`<div class="warn">⚠ ${escapeHtml(a)}</div>`).join("")}
        <div class="form-row" style="margin-top:12px"><button id="c-crear-lista" style="width:100%">Crear lista</button></div>
      </div>`;

    document.getElementById("c-crear-lista").addEventListener("click", ()=> crearListaDesdeDetalle(pendientes));
    cont.querySelectorAll("[data-yatengo]").forEach(b=>{
      b.addEventListener("click", ()=>{
        abrirModalTengo(filasCalc.find(x=>x.prod.id===b.dataset.yatengo));
      });
    });
    cont.querySelectorAll("[data-deshacer]").forEach(b=>{
      b.addEventListener("click", ()=>{
        calcTengo.delete(b.dataset.deshacer);
        renderCalcular();
      });
    });
  }

  const opcionesUnidadDim = (dim, sel)=> Object.entries(UNIDADES).filter(([,u])=>u.dim===dim)
    .map(([k,u])=>`<option value="${k}"${k===sel?" selected":""}>${u.txt}</option>`).join("");

  // Ventana: confirmar que ya tiene el producto e indicar cuánto tiene
  function abrirModalTengo(f){
    if(!f) return;
    const inicial = calcTengo.has(f.prod.id) ? calcTengo.get(f.prod.id) : f.base;
    abrirModal(`
      <h3>Ya tengo este producto</h3>
      <p><b>${escapeHtml(f.prod.name)}</b>: necesitas ${cantidadBonita(f.base, f.dim)}.</p>
      <p class="muted">¿Seguro que ya lo tienes? Escribe cuánto tienes y se restará de lo que necesitas comprar.</p>
      <div class="form-row">
        <input id="m-tengo-cant" type="number" step="any" min="0" inputmode="decimal" placeholder="Cantidad que tienes">
        <select id="m-tengo-unidad"></select>
      </div>
      <div class="modal-actions">
        <button class="secondary" id="modal-cancelar">Cancelar</button>
        <button id="modal-guardar">Sí, ya lo tengo</button>
      </div>
    `);
    document.getElementById("m-tengo-cant").value = parseFloat((inicial / UNIDADES[f.prod.unit].f).toFixed(6));
    document.getElementById("m-tengo-unidad").innerHTML = opcionesUnidadDim(f.dim, f.prod.unit);
    document.getElementById("modal-cancelar").addEventListener("click", cerrarModal);
    document.getElementById("modal-guardar").addEventListener("click", ()=>{
      const cant = parseFloat(document.getElementById("m-tengo-cant").value);
      const unit = document.getElementById("m-tengo-unidad").value;
      if(!(cant>=0)){ alert("Escribe cuánto tienes."); return; }
      const base = cant * UNIDADES[unit].f;
      if(base>0) calcTengo.set(f.prod.id, base); else calcTengo.delete(f.prod.id);
      cerrarModal();
      renderCalcular();
    });
  }

  // ---- Lista de compras ----
  const listaRef = collection(db, "lista");
  let lista = [];
  let lBuscar = "", lLugar = "";
  const elLNombre = document.getElementById("l-nombre");
  const elLLugar = document.getElementById("l-lugar");
  const elLUnidades = document.getElementById("l-unidades");
  const elLBuscar = document.getElementById("l-buscar");
  const elLFiltroLugar = document.getElementById("l-filtro-lugar");
  const elLGramaje = document.getElementById("l-gramaje");
  const elLGramajeU = document.getElementById("l-gramaje-unidad");
  elLGramajeU.innerHTML = opcionesUnidad("");
  let lastProdId = null;

  onSnapshot(listaRef, (snapshot)=>{
    lista = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    renderLista();
  }, (error)=>{
    console.error("Error leyendo la lista:", error);
    document.getElementById("l-pendientes").innerHTML =
      '<div class="empty">No se pudo conectar con la base de datos. Revisa la consola.</div>';
  });

  // al escribir un producto que ya existe, se sugiere su lugar de compra
  elLNombre.addEventListener("input", ()=>{
    const p = productos.find(x=>x.name.toLowerCase()===elLNombre.value.trim().toLowerCase());
    if(p && p.place && !elLLugar.value.trim()) elLLugar.value = p.place;
    if(p && p.unit && lastProdId!==p.id) elLGramajeU.value = p.unit;
    lastProdId = p ? p.id : null;
    actualizarAvisoManual();
  });
  elLBuscar.addEventListener("input", ()=>{ lBuscar = elLBuscar.value; renderLista(); });
  elLFiltroLugar.addEventListener("change", ()=>{ lLugar = elLFiltroLugar.value; renderLista(); });

  // ---- Agregar manual por gramaje: calcula las unidades a comprar con las presentaciones del producto ----
  function planManual(){
    const cant = parseFloat(elLGramaje.value);
    if(!(cant>0)) return null; // sin gramaje: se usan las unidades escritas a mano
    const prod = productos.find(p=>p.name.toLowerCase()===elLNombre.value.trim().toLowerCase());
    if(!prod) return { motivo:"Para calcular las unidades, el producto debe existir en Productos." };
    const pu = UNIDADES[prod.unit];
    if(!pu) return { motivo:"Al producto le falta la unidad (edítalo en Productos)." };
    const iu = UNIDADES[elLGramajeU.value];
    if(!iu) return { motivo:"Elige la unidad del gramaje." };
    if(iu.dim!==pu.dim) return { motivo:`No se puede convertir ${elLGramajeU.value} a ${prod.unit}.` };
    const falta = cant * iu.f;
    return { prod, falta, compra: mejorCompra(falta, presentaciones(prod)) };
  }
  const textoPlan = (plan)=> plan.compra.lineas.filter(l=>l.n>0)
    .map(l=>`x${l.n} de ${numero(l.quantity)} ${escapeHtml(plan.prod.unit)}`).join(" + ");

  function actualizarAvisoManual(){
    const plan = planManual();
    elLUnidades.disabled = !!(parseFloat(elLGramaje.value)>0);
    document.getElementById("l-aviso").innerHTML = !plan ? "" :
      plan.motivo ? `<span class="warn">⚠ ${escapeHtml(plan.motivo)}</span>` :
      `Necesitas: <b>${textoPlan(plan)}</b> · ${dinero(plan.compra.total)}`;
  }
  elLGramaje.addEventListener("input", actualizarAvisoManual);
  elLGramajeU.addEventListener("change", actualizarAvisoManual);

  document.getElementById("l-agregar").addEventListener("click", async ()=>{
    const name = elLNombre.value.trim();
    const units = parseInt(elLUnidades.value);
    if(!name){ alert("Escribe el producto que necesitas comprar."); return; }
    const plan = planManual();
    if(plan){
      if(plan.motivo){ alert(plan.motivo); return; }
      const lineas = plan.compra.lineas.filter(l=>l.n>0);
      if(lineas.length===0){ alert("Con esa cantidad no hay nada que comprar."); return; }
      try{
        const place = elLLugar.value.trim() || plan.prod.place || "";
        await Promise.all(lineas.map(l=>addDoc(listaRef, {
          name: plan.prod.name, place, units: l.n,
          presentacion: `paquete de ${numero(l.quantity)} ${plan.prod.unit}`,
          presQty: l.quantity, precioUnit: l.price, productId: plan.prod.id, comprado: false
        })));
        document.getElementById("l-aviso").innerHTML = `Agregado: <b>${escapeHtml(plan.prod.name)}</b> — ${textoPlan(plan)} · ${dinero(plan.compra.total)}`;
        elLNombre.value = elLLugar.value = elLGramaje.value = ""; elLUnidades.value = "1"; elLUnidades.disabled = false;
        lastProdId = null;
      }catch(e){ console.error(e); alert("No se pudo agregar a la lista."); }
      return;
    }
    if(!(units>0)){ alert("Escribe cuántas unidades debes comprar."); return; }
    const prod = productos.find(p=>p.name.toLowerCase()===name.toLowerCase());
    try{
      await addDoc(listaRef, {
        name: prod ? prod.name : name,
        place: elLLugar.value.trim() || (prod && prod.place) || "",
        units,
        presentacion: prod && prod.unit ? `paquete de ${numero(prod.quantity)} ${prod.unit}` : "",
        productId: prod ? prod.id : "",
        comprado: false
      });
      elLNombre.value = elLLugar.value = ""; elLUnidades.value = "1";
    }catch(e){ console.error(e); alert("No se pudo agregar a la lista."); }
  });

  // Precio de un producto de la lista = unidades x precio del producto (null si no se encuentra el producto)
  function precioItem(i){
    const p = productos.find(x=>x.id===i.productId) ||
              productos.find(x=>(x.name||"").toLowerCase()===(i.name||"").toLowerCase());
    if(i.precioUnit!==undefined) return (Number(i.precioUnit)||0) * (Number(i.units)||1);
    return p ? (Number(p.price)||0) * (Number(i.units)||1) : null;
  }

  function filaLista(i){
    return `
      <div class="item${i.comprado ? " hecho" : ""}">
        <input type="checkbox" data-l-chk="${i.id}" ${i.comprado ? "checked" : ""} aria-label="Comprado">
        <div class="item-info"><b>${escapeHtml(i.name||"")}</b> — x${escapeHtml(String(i.units||1))}
          ${i.presentacion ? `<span class="muted">(${escapeHtml(i.presentacion)})</span>` : ""}
          <div class="muted">${i.place ? "Comprar en: "+escapeHtml(i.place) : "Sin lugar de compra"}${precioItem(i)!==null ? " · "+dinero(precioItem(i)) : ""}</div>
        </div>
        <div class="item-actions"><button class="small danger" data-l-del="${i.id}">Eliminar</button></div>
      </div>`;
  }

  function renderLista(){
    document.getElementById("l-eliminar-wrap").style.display = lista.length ? "" : "none";
    const porNombre = (a,b)=> (a||"").localeCompare(b||"");
    document.getElementById("l-productos").innerHTML = productos.map(p=>`<option value="${escapeHtml(p.name)}">`).join("");
    const todosLugares = [...new Set([...productos.map(p=>p.place), ...lista.map(i=>i.place)].filter(l=>l && l.trim()))].sort(porNombre);
    document.getElementById("l-lugares").innerHTML = todosLugares.map(l=>`<option value="${escapeHtml(l)}">`).join("");

    const lugaresLista = [...new Set(lista.map(i=>i.place).filter(l=>l && l.trim()))].sort(porNombre);
    const prev = elLFiltroLugar.value;
    elLFiltroLugar.innerHTML = '<option value="">Todos los lugares</option>' +
      lugaresLista.map(l=>`<option value="${escapeHtml(l)}">${escapeHtml(l)}</option>`).join("");
    if(lugaresLista.includes(prev)) elLFiltroLugar.value = prev; else lLugar = "";

    const q = lBuscar.trim().toLowerCase();
    const visibles = lista
      .filter(i=> (!lLugar || i.place===lLugar) && (!q || (i.name||"").toLowerCase().includes(q)))
      .sort((a,b)=> porNombre(a.place,b.place) || porNombre(a.name,b.name));
    const pend = visibles.filter(i=>!i.comprado);
    const comp = visibles.filter(i=>i.comprado);

    // Cuadro de total: lo que falta por pagar baja cada vez que se marca algo como comprado
    let falta = 0, pagado = 0, sinPrecio = 0;
    visibles.forEach(i=>{
      const t = precioItem(i);
      if(t===null){ sinPrecio++; return; }
      if(i.comprado) pagado += t; else falta += t;
    });
    document.getElementById("l-total").innerHTML = lista.length===0 ? "" : `
      <div class="card">
        <div class="total-box">
          <div class="muted">${(lLugar || q) ? "Falta por pagar (con el filtro actual)" : "Falta por pagar"}</div>
          <div class="big">${dinero(falta)}</div>
          <div class="muted">Ya comprado: ${dinero(pagado)} · Total de la lista: ${dinero(falta+pagado)}</div>
          ${sinPrecio ? `<div class="warn">⚠ ${sinPrecio} producto(s) sin precio no están en el total.</div>` : ""}
        </div>
      </div>`;

    const cp = document.getElementById("l-pendientes");
    const cc = document.getElementById("l-comprados");
    if(lista.length===0){
      cp.innerHTML = '<div class="empty">Tu lista está vacía. Agrega productos arriba o créala desde Calcular.</div>';
    } else if(visibles.length===0){
      cp.innerHTML = '<div class="empty">No hay productos con ese filtro.</div>';
    } else {
      cp.innerHTML = `<div class="card"><div class="muted" style="margin-bottom:4px">Por comprar (${pend.length})</div>
        ${pend.length ? pend.map(filaLista).join("") : '<div class="empty">No tienes nada pendiente 🎉</div>'}</div>`;
    }
    cc.innerHTML = comp.length ? `<div class="card"><div class="muted" style="margin-bottom:4px">Ya comprado (${comp.length})</div>
      ${comp.map(filaLista).join("")}</div>` : "";

    document.getElementById("panel-lista").querySelectorAll("[data-l-chk]").forEach(c=>{
      c.addEventListener("change", async ()=>{
        try{ await updateDoc(doc(db, "lista", c.dataset.lChk), { comprado: c.checked }); }
        catch(e){ console.error(e); alert("No se pudo actualizar el producto."); }
      });
    });
    document.getElementById("panel-lista").querySelectorAll("[data-l-del]").forEach(b=>{
      b.addEventListener("click", ()=>{
        const i = lista.find(x=>x.id===b.dataset.lDel);
        confirmarAccion(`¿Quitar "${i.name}" de la lista?`, "Quitar", async ()=>{
          try{ await deleteDoc(doc(db, "lista", i.id)); }
          catch(e){ console.error(e); alert("No se pudo quitar el producto."); }
        });
      });
    });
  }

  // Eliminar toda la lista (con ventana de confirmación)
  document.getElementById("l-eliminar-todo").addEventListener("click", ()=>{
    if(lista.length===0) return;
    confirmarAccion(
      `¿Eliminar toda la lista (${lista.length} producto(s))? Esta acción no se puede deshacer.`,
      "OK",
      async ()=>{
        try{ await Promise.all(lista.map(i=>deleteDoc(doc(db, "lista", i.id)))); }
        catch(e){ console.error(e); alert("No se pudo eliminar la lista."); }
      }
    );
  });

  // Crea la lista a partir del detalle de Calcular (una línea por presentación a comprar) y abre la pestaña Lista
  async function crearListaDesdeDetalle(items){
    const aComprar = items.filter(f=>f.paquetesComprar>0);
    if(aComprar.length===0){ alert("No hay nada por comprar en el detalle."); return; }
    try{
      const ops = [];
      aComprar.forEach(f=>{
        const lineas = f.compra.lineas.filter(l=>l.n>0);
        const quedan = new Set(lineas.map(l=>l.quantity));
        // pendientes viejos del mismo producto que ya no se necesitan
        lista.filter(i=>i.productId===f.prod.id && !i.comprado && !quedan.has(i.presQty))
             .forEach(i=>ops.push(deleteDoc(doc(db, "lista", i.id))));
        lineas.forEach(l=>{
          const data = {
            name: f.prod.name, place: f.prod.place || "", units: l.n,
            presentacion: `paquete de ${numero(l.quantity)} ${f.prod.unit}`,
            presQty: l.quantity, precioUnit: l.price,
            productId: f.prod.id, comprado: false
          };
          const ya = lista.find(i=>i.productId===f.prod.id && i.presQty===l.quantity && !i.comprado);
          ops.push(ya ? updateDoc(doc(db, "lista", ya.id), data) : addDoc(listaRef, data));
        });
      });
      await Promise.all(ops);
      document.querySelector('.tab[data-tab="lista"]').click();
    }catch(e){ console.error(e); alert("No se pudo crear la lista."); }
  }

  function escapeHtml(str){
    return String(str).replace(/[&<>"']/g, s=>({
      "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
    }[s]));
  }
})();
