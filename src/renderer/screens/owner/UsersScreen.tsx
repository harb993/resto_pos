import React, { useState, useEffect } from 'react'

export default function UsersScreen() {
  const [users, setUsers] = useState<any[]>([])
  const [showModal, setShowModal] = useState(false)
  const [form, setForm] = useState({ username: '', password: '', pin: '', role: 'cashier', fullName: '' })
  const [toast, setToast] = useState<{ msg: string; type: string } | null>(null)

  useEffect(() => { loadUsers() }, [])

  const loadUsers = async () => {
    const res = await window.api.listUsers()
    if (res.success) setUsers(res.data)
  }

  const createUser = async () => {
    if (!form.username || !form.password || !form.fullName) return
    const res = await window.api.createUser(form)
    if (res.success) {
      setToast({ msg: 'User created', type: 'success' }); setTimeout(() => setToast(null), 3000)
      setShowModal(false); loadUsers()
      setForm({ username: '', password: '', pin: '', role: 'cashier', fullName: '' })
    } else {
      setToast({ msg: res.error || 'Failed', type: 'error' }); setTimeout(() => setToast(null), 3000)
    }
  }

  const toggleActive = async (userId: number, current: boolean) => {
    await window.api.toggleUserActive(userId, !current)
    loadUsers()
  }

  return (
    <div className="animate-fade">
      <div className="page-header">
        <div><h1 className="page-title">Users</h1><p className="page-subtitle">{users.length} user accounts</p></div>
        <button className="btn btn-primary" onClick={() => setShowModal(true)}>+ Add User</button>
      </div>

      <div className="table-container">
        <table>
          <thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Status</th><th>Created</th><th>Actions</th></tr></thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.user_id}>
                <td style={{ fontWeight: 600 }}>{u.full_name}</td>
                <td>{u.username}</td>
                <td><span className={`badge ${u.role === 'owner' ? 'badge-warning' : 'badge-info'}`}>{u.role}</span></td>
                <td><span className={`badge ${u.is_active ? 'badge-success' : 'badge-danger'}`}>{u.is_active ? 'Active' : 'Inactive'}</span></td>
                <td style={{ fontSize: 13, color: 'var(--text-muted)' }}>{new Date(u.created_at).toLocaleDateString()}</td>
                <td>
                  <button className="btn btn-ghost btn-sm" onClick={() => toggleActive(u.user_id, u.is_active)}>
                    {u.is_active ? 'Deactivate' : 'Activate'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showModal && (
        <div className="modal-overlay" onClick={() => setShowModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2 className="modal-title">Add User</h2>
            <div className="form-group"><label className="form-label">Full Name</label><input className="input" value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} /></div>
            <div className="form-group"><label className="form-label">Username</label><input className="input" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} /></div>
            <div className="form-group"><label className="form-label">Password</label><input className="input" type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></div>
            <div className="form-group"><label className="form-label">PIN (4 digits)</label><input className="input" value={form.pin} onChange={(e) => setForm({ ...form, pin: e.target.value })} maxLength={6} placeholder="Optional" /></div>
            <div className="form-group">
              <label className="form-label">Role</label>
              <select className="input" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
                <option value="cashier">Cashier</option>
                <option value="owner">Owner</option>
              </select>
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 20 }}>
              <button className="btn btn-secondary" onClick={() => setShowModal(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={createUser}>Create User</button>
            </div>
          </div>
        </div>
      )}

      {toast && <div className={`toast toast-${toast.type}`}>{toast.msg}</div>}
    </div>
  )
}
