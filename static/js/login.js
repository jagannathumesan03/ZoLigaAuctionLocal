function switchRole(role) {
  document.getElementById('tabAdmin').classList.toggle('active', role === 'admin');
  document.getElementById('tabViewer').classList.toggle('active', role === 'viewer');
  document.getElementById('tabAdmin').setAttribute('aria-selected', role === 'admin' ? 'true' : 'false');
  document.getElementById('tabViewer').setAttribute('aria-selected', role === 'viewer' ? 'true' : 'false');
  document.getElementById('adminForm').style.display = role === 'admin' ? 'block' : 'none';
  document.getElementById('viewerForm').style.display = role === 'viewer' ? 'block' : 'none';
  document.getElementById('errorMsg').textContent = '';
}

document.getElementById('adminForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = document.getElementById('adminUsername').value;
  const password = document.getElementById('adminPassword').value;
  try {
    const res = await fetch('/api/auth/login/admin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    if (!res.ok) throw new Error((await res.json()).detail || 'Login failed');
    window.location.href = '/admin';
  } catch (err) {
    document.getElementById('errorMsg').textContent = err.message;
  }
});

document.getElementById('viewerForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const password = document.getElementById('viewerPassword').value;
  try {
    const res = await fetch('/api/auth/login/viewer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    if (!res.ok) throw new Error((await res.json()).detail || 'Login failed');
    window.location.href = '/viewer';
  } catch (err) {
    document.getElementById('errorMsg').textContent = err.message;
  }
});

// If already logged in, redirect appropriately
(async () => {
  try {
    const res = await fetch('/api/auth/me');
    if (res.ok) {
      const data = await res.json();
      window.location.href = data.role === 'admin' ? '/admin' : '/viewer';
    }
  } catch (e) { /* not logged in, stay on login page */ }
})();
