/**
 * SAVE PVP — Capa de comunicación con la API
 * Todas las llamadas HTTP centralizadas aquí.
 */

const API = (() => {
  const BASE = '/api';

  function getToken() { return localStorage.getItem('savePvpToken'); }
  function setToken(t) { localStorage.setItem('savePvpToken', t); }
  function clearToken() { localStorage.removeItem('savePvpToken'); }

  async function request(method, endpoint, body = null) {
    const token = getToken();
    const opts = {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    };
    if (body) opts.body = JSON.stringify(body);

    const res = await fetch(BASE + endpoint, opts);

    // Token expirado → redirigir al login
    if (res.status === 401) {
      clearToken();
      window.location.href = '/login.html';
      return null;
    }

    const data = await res.json();
    if (!res.ok) {
      const err = new Error(data.error || 'Error en la petición');
      if (data?.code) err.code = data.code;
      throw err;
    }
    return data;
  }

  return {
    // ── Auth ────────────────────────────────
    login: (username, password) =>
      request('POST', '/auth/login', { username, password }),
    me: () =>
      request('GET', '/auth/me'),
    changePasswordFirstLogin: (newPassword) =>
      request('POST', '/auth/change-password-first-login', { newPassword }),
    logout: () => {
      clearToken();
      window.location.href = '/';
    },
    setToken, getToken, clearToken,

    // ── Repuestos ───────────────────────────
    repuestos: {
      listar:    (params = {}) => request('GET', '/repuestos?' + new URLSearchParams(params)),
      obtener:   (id)          => request('GET', `/repuestos/${id}`),
      crear:     (data)        => request('POST', '/repuestos', data),
      actualizar:(id, data)    => request('PUT', `/repuestos/${id}`, data),
      eliminar:  (id)          => request('DELETE', `/repuestos/${id}`),
    },
    dashboard: {
      resumen: () => request('GET', '/dashboard/resumen'),
    },
    busquedaGlobal: (q) => request('GET', '/busqueda-global?' + new URLSearchParams({ q })),

    // ── Solicitudes PVP ─────────────────────
    solicitudes: {
      listar:   (params = {}) => request('GET', '/solicitudes?' + new URLSearchParams(params)),
      validarReferencia: (referencia) => request('GET', '/solicitudes/validar-referencia?' + new URLSearchParams({ referencia })),
      crear:    (data)        => request('POST', '/solicitudes', data),
      aprobar:  (id, data)    => request('PUT', `/solicitudes/${id}/aprobar`, data),
      rechazar: (id, motivo)  => request('PUT', `/solicitudes/${id}/rechazar`, { motivo_rechazo: motivo }),
    },
    reportes: {
      listar:   (params = {}) => request('GET', '/reportes-referencias?' + new URLSearchParams(params)),
      crear:    (data)        => request('POST', '/reportes-referencias', data),
      resolver: (id, data = {}) => request('PUT', `/reportes-referencias/${id}/resolver`, data),
      rechazar: (id, motivo)  => request('PUT', `/reportes-referencias/${id}/rechazar`, { motivo_rechazo: motivo }),
    },
    pedidos: {
      listar:   (params = {}) => request('GET', '/pedidos?' + new URLSearchParams(params)),
      resumen:  ()            => request('GET', '/pedidos/resumen'),
      tiendas:  ()            => request('GET', '/pedidos/tiendas'),
      crear:    (items)       => request('POST', '/pedidos', { items }),
      actualizar:(id, data)   => request('PUT', `/pedidos/${id}`, data),
    },

    // ── Usuarios ────────────────────────────
    usuarios: {
      listar:    ()           => request('GET', '/usuarios'),
      crear:     (data)       => request('POST', '/usuarios', data),
      actualizar:(id, data)   => request('PUT', `/usuarios/${id}`, data),
      eliminar:  (id)         => request('DELETE', `/usuarios/${id}`),
    },

    // ── Categorías ──────────────────────────
    categorias: {
      listar: () => request('GET', '/categorias'),
      crear:  (nombre) => request('POST', '/categorias', { nombre }),
    },

    // ── Apple Original ──────────────────────
    apple: {
      listar: (params = {}) => request('GET', '/apple?' + new URLSearchParams(params)),
      crear:     (data)      => request('POST', '/apple', data),
      actualizar:(id, data) => request('PUT', `/apple/${id}`, data),
      eliminar:  (id)       => request('DELETE', `/apple/${id}`),
    },

    // ── Oppo Original ───────────────────────
    oppo: {
      listar: (params = {}) => request('GET', '/oppo?' + new URLSearchParams(params)),
      crear:     (data)      => request('POST', '/oppo', data),
      actualizar:(id, data) => request('PUT', `/oppo/${id}`, data),
      eliminar:  (id)       => request('DELETE', `/oppo/${id}`),
    },

    // ── Teléfonos ───────────────────────────
    telefonos: {
      listar: (params = {}) => request('GET', '/telefonos?' + new URLSearchParams(params)),
      crear:     (data)      => request('POST', '/telefonos', data),
      actualizar:(id, data) => request('PUT', `/telefonos/${id}`, data),
      eliminar:  (id)       => request('DELETE', `/telefonos/${id}`),
    },
    consolas: {
      listar: (params = {}) => request('GET', '/consolas?' + new URLSearchParams(params)),
      crear:     (data)      => request('POST', '/consolas', data),
      actualizar:(id, data) => request('PUT', `/consolas/${id}`, data),
      eliminar:  (id)       => request('DELETE', `/consolas/${id}`),
    },
  };
})();
