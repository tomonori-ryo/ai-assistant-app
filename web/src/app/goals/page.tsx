"use client";
import { useEffect, useState } from 'react';
import { getGoals, addGoal, updateGoal, deleteGoal, type Goal } from '../../lib/firestore';
import { format } from 'date-fns';
import { ja } from 'date-fns/locale';

export default function GoalsPage() {
  const [goals, setGoals] = useState<Goal[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddGoal, setShowAddGoal] = useState(false);
  const [showAISupportModal, setShowAISupportModal] = useState(false);
  
  // 新規ゴールフォーム
  const [newGoalTitle, setNewGoalTitle] = useState('');
  const [newGoalDescription, setNewGoalDescription] = useState('');
  const [newGoalDeadline, setNewGoalDeadline] = useState('');
  const [newGoalCategory, setNewGoalCategory] = useState<'work_study' | 'life_chores' | 'leisure' | 'other'>('work_study');
  
  // AIチャット（ゴール分解）
  const [aiChatMessages, setAiChatMessages] = useState<Array<{ role: 'user' | 'assistant'; content: string }>>([]);
  const [aiChatInput, setAiChatInput] = useState('');
  const [aiProcessing, setAiProcessing] = useState(false);
  const [generatedRoadmap, setGeneratedRoadmap] = useState<any>(null);
  
  // AIサポートレベル選択（最終ステップ）
  const [selectedAiSupportLevel, setSelectedAiSupportLevel] = useState<'auto' | 'suggest'>('auto');
  
  // プロジェクトインポート
  const [showImport, setShowImport] = useState(false);
  const [importText, setImportText] = useState('');
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importProcessing, setImportProcessing] = useState(false);
  const [importResult, setImportResult] = useState<any>(null);
  
  // 目標詳細とタスク生成
  const [selectedGoal, setSelectedGoal] = useState<Goal | null>(null);
  const [showTaskGenerator, setShowTaskGenerator] = useState(false);
  const [taskGenerationPrompt, setTaskGenerationPrompt] = useState('');
  const [generatingTasks, setGeneratingTasks] = useState(false);
  const [suggestedTasks, setSuggestedTasks] = useState<any[]>([]);
  const [selectedTaskIndices, setSelectedTaskIndices] = useState<Set<number>>(new Set());
  
  // 目標編集
  const [editingGoal, setEditingGoal] = useState<Goal | null>(null);
  const [editForm, setEditForm] = useState({
    title: '',
    description: '',
    deadline: '',
    category: 'work_study' as 'work_study' | 'life_chores' | 'leisure' | 'other'
  });

  useEffect(() => {
    loadGoals();
  }, []);

  const loadGoals = async () => {
    setLoading(true);
    try {
      const data = await getGoals();
      setGoals(data);
    } catch (error) {
      console.error('[Goals] Load error:', error);
    } finally {
      setLoading(false);
    }
  };

  const startAddGoal = () => {
    setNewGoalTitle('');
    setNewGoalDescription('');
    setNewGoalDeadline('');
    setNewGoalCategory('work_study');
    setAiChatMessages([
      {
        role: 'assistant',
        content: 'こんにちは！AIゴールプランナーです。まず、達成したい目標を教えてください。\n\n例：「基本情報技術者試験に合格したい」「毎日30分英語を勉強する」'
      }
    ]);
    setShowAddGoal(true);
  };

  const sendAiMessage = async () => {
    if (!aiChatInput.trim() || aiProcessing) return;

    const userMessage = aiChatInput.trim();
    setAiChatInput('');
    setAiProcessing(true);

    // ユーザーメッセージを追加
    const updatedMessages = [...aiChatMessages, { role: 'user' as const, content: userMessage }];
    setAiChatMessages(updatedMessages);

    try {
      // Gemini APIを使ってゴール分解
      const response = await fetch('/api/goal/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: updatedMessages,
          currentGoal: {
            title: newGoalTitle || userMessage,
            description: newGoalDescription
          }
        })
      });

      const data = await response.json();

      if (data.success) {
        // AIの応答を追加
        setAiChatMessages([...updatedMessages, { role: 'assistant', content: data.message }]);

        // ゴール情報が抽出された場合
        if (data.goalInfo) {
          setNewGoalTitle(data.goalInfo.title || newGoalTitle);
          setNewGoalDescription(data.goalInfo.description || newGoalDescription);
          setNewGoalDeadline(data.goalInfo.deadline || newGoalDeadline);
          setNewGoalCategory(data.goalInfo.category || newGoalCategory);
        }

        // ロードマップが生成された場合
        if (data.roadmap) {
          setGeneratedRoadmap(data.roadmap);
          
          // ロードマップ生成完了 → AIサポートレベル選択へ
          setTimeout(() => {
            setShowAISupportModal(true);
          }, 500);
        }
      } else {
        setAiChatMessages([...updatedMessages, { 
          role: 'assistant', 
          content: 'エラーが発生しました。もう一度お試しください。' 
        }]);
      }
    } catch (error) {
      console.error('[Goals] AI chat error:', error);
      setAiChatMessages([...updatedMessages, { 
        role: 'assistant', 
        content: 'エラーが発生しました。もう一度お試しください。' 
      }]);
    } finally {
      setAiProcessing(false);
    }
  };

  const saveGoal = async () => {
    if (!newGoalTitle.trim()) {
      alert('目標のタイトルを入力してください');
      return;
    }

    try {
      await addGoal({
        title: newGoalTitle,
        description: newGoalDescription || undefined,
        deadline: newGoalDeadline || null,
        category: newGoalCategory,
        aiSupportLevel: selectedAiSupportLevel,
        roadmap: generatedRoadmap || undefined,
        progress: 0,
        status: 'active'
      });

      alert('目標を作成しました！');
      setShowAddGoal(false);
      setShowAISupportModal(false);
      loadGoals();
    } catch (error) {
      console.error('[Goals] Save error:', error);
      alert('目標の作成に失敗しました');
    }
  };

  const toggleGoalStatus = async (goal: Goal) => {
    const newStatus = goal.status === 'active' ? 'paused' : 'active';
    
    try {
      await updateGoal(goal.id!, { status: newStatus });
      loadGoals();
    } catch (error) {
      console.error('[Goals] Update error:', error);
    }
  };

  const removeGoal = async (goalId: string) => {
    if (!confirm('この目標を削除しますか？')) return;

    try {
      await deleteGoal(goalId);
      loadGoals();
    } catch (error) {
      console.error('[Goals] Delete error:', error);
    }
  };

  // プロジェクトインポート処理
  const handleImport = async () => {
    if (!importText.trim() && !importFile) {
      alert('テキストを入力するか、ファイルをアップロードしてください');
      return;
    }

    setImportProcessing(true);

    try {
      let textContent = importText;

      // ファイルがある場合は読み込み
      if (importFile) {
        const fileText = await readFileContent(importFile);
        textContent = fileText || importText;
      }

      // AIで解析
      const response = await fetch('/api/project/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: textContent })
      });

      const data = await response.json();

      if (data.success) {
        setImportResult(data.result);
        
        // サポートレベル選択へ
        setTimeout(() => {
          setShowAISupportModal(true);
        }, 500);
      } else {
        alert('インポートに失敗しました: ' + (data.error || '不明なエラー'));
      }
    } catch (error) {
      console.error('[Goals] Import error:', error);
      alert('インポートに失敗しました');
    } finally {
      setImportProcessing(false);
    }
  };

  // ファイル読み込み
  const readFileContent = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => resolve(e.target?.result as string);
      reader.onerror = reject;
      reader.readAsText(file);
    });
  };

  // インポート結果を保存
  const saveImportedProject = async () => {
    if (!importResult) return;

    try {
      // 目標を作成
      const goalData: Omit<Goal, 'id' | 'createdAt' | 'updatedAt'> = {
        title: importResult.goal.title,
        description: importResult.goal.description || undefined,
        deadline: importResult.goal.deadline || null,
        category: importResult.goal.category || 'work_study',
        aiSupportLevel: selectedAiSupportLevel,
        roadmap: importResult.goal.roadmap || undefined,
        progress: 0,
        status: 'active'
      };

      const newGoalId = await addGoal(goalData);

      // タスクを作成（目標IDを紐付け、順序番号も付与）
      if (importResult.tasks && importResult.tasks.length > 0) {
        const { getFirebase } = await import('../../lib/firebase');
        const { db, auth } = await getFirebase();
        const user = auth.currentUser;
        if (!user) throw new Error('Not signed in');

        const { addDoc, collection, serverTimestamp } = await import('firebase/firestore');
        const tasksCol = collection(db, 'users', user.uid, 'tasks');

        for (let i = 0; i < importResult.tasks.length; i++) {
          const task = importResult.tasks[i];
          await addDoc(tasksCol, {
            title: task.title,
            description: task.description || null,
            category: task.category || 'work_study',
            priorityScore: task.priorityScore || 1,
            dueDate: task.dueDate || null,
            location: null,
            completed: false,
            parent_task_id: null,
            relatedGoalId: newGoalId || null,
            order: i, // 順序番号を付与
            createdAt: serverTimestamp()
          });
        }
      }

      alert(`[完了] 目標「${importResult.goal.title}」と${importResult.tasks?.length || 0}個のタスクをインポートしました！`);
      setShowImport(false);
      setShowAISupportModal(false);
      setImportText('');
      setImportFile(null);
      setImportResult(null);
      loadGoals();
    } catch (error) {
      console.error('[Goals] Save imported project error:', error);
      alert('保存に失敗しました');
    }
  };

  // 目標からタスクを生成
  const openTaskGenerator = (goal: Goal) => {
    setSelectedGoal(goal);
    setSuggestedTasks([]);
    setSelectedTaskIndices(new Set());
    setTaskGenerationPrompt('');
    setShowTaskGenerator(true);
    
    // 初回は自動で生成
    generateTasksFromGoal(goal, '');
  };

  const generateTasksFromGoal = async (goal: Goal, userPrompt: string) => {
    setGeneratingTasks(true);

    try {
      const response = await fetch('/api/goal/generate-tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          goal: {
            title: goal.title,
            description: goal.description,
            deadline: goal.deadline,
            roadmap: goal.roadmap,
            progress: goal.progress
          },
          userPrompt
        })
      });

      const data = await response.json();

      if (data.success && data.subtasks) {
        // parentTaskとsubtasksを結合して表示用のリストを作成
        const tasksForDisplay = [
          ...(data.parentTask ? [{
            ...data.parentTask,
            isParent: true
          }] : []),
          ...(data.subtasks || []).map((st: any) => ({
            ...st,
            isParent: false
          }))
        ];
        
        setSuggestedTasks(tasksForDisplay);
        setSelectedTaskIndices(new Set()); // 初期状態は未選択
      } else {
        alert('タスク生成に失敗しました: ' + (data.error || '不明なエラー'));
      }
    } catch (error) {
      console.error('[Goals] Task generation error:', error);
      alert('タスク生成に失敗しました');
    } finally {
      setGeneratingTasks(false);
    }
  };

  const handleGenerateTasks = () => {
    if (!selectedGoal) return;
    generateTasksFromGoal(selectedGoal, taskGenerationPrompt);
    setTaskGenerationPrompt('');
  };

  const toggleTaskSelection = (index: number) => {
    const newSelected = new Set(selectedTaskIndices);
    if (newSelected.has(index)) {
      newSelected.delete(index);
    } else {
      newSelected.add(index);
    }
    setSelectedTaskIndices(newSelected);
  };

  const saveGeneratedTasks = async () => {
    if (!selectedGoal || selectedTaskIndices.size === 0) {
      alert('タスクを選択してください');
      return;
    }

    try {
      const { getFirebase } = await import('../../lib/firebase');
      const { db, auth } = await getFirebase();
      const user = auth.currentUser;
      if (!user) throw new Error('Not signed in');

      const { addDoc, collection, serverTimestamp } = await import('firebase/firestore');
      const tasksCol = collection(db, 'users', user.uid, 'tasks');

      const selectedTasks = Array.from(selectedTaskIndices)
        .map(index => suggestedTasks[index])
        .filter(Boolean);

      // 親タスクとサブタスクを分離
      const parentTask = selectedTasks.find((t: any) => t.isParent);
      const subtasks = selectedTasks.filter((t: any) => !t.isParent);

      let parentTaskId = null;

      // 親タスクがある場合は先に作成
      if (parentTask) {
        const parentDoc = await addDoc(tasksCol, {
          title: parentTask.title,
          description: parentTask.description || null,
          category: selectedGoal.category || 'work_study',
          priorityScore: parentTask.priorityScore || 1,
          dueDate: parentTask.dueDate || null,
          location: null,
          completed: false,
          parent_task_id: null,
          relatedGoalId: selectedGoal.id || null,
          order: 0,
          createdAt: serverTimestamp()
        });
        parentTaskId = parentDoc.id;
      }

      // サブタスクを作成（親タスクのIDと目標IDを紐付け、順序番号も付与）
      for (let i = 0; i < subtasks.length; i++) {
        const task = subtasks[i];
        await addDoc(tasksCol, {
          title: task.title,
          description: task.description || null,
          category: selectedGoal.category || 'work_study',
          priorityScore: task.priorityScore || 1,
          dueDate: task.dueDate || null,
          location: null,
          completed: false,
          parent_task_id: parentTaskId,
          relatedGoalId: selectedGoal.id || null,
          order: i, // 順序番号を付与
          createdAt: serverTimestamp()
        });
      }

      const message = parentTask 
        ? `[完了] 親タスク「${parentTask.title}」と${subtasks.length}個のサブタスクを追加しました！`
        : `[完了] ${selectedTasks.length}個のタスクを追加しました！`;
      
      alert(message);
      setShowTaskGenerator(false);
      setSelectedGoal(null);
      setSuggestedTasks([]);
      setSelectedTaskIndices(new Set());
    } catch (error) {
      console.error('[Goals] Save generated tasks error:', error);
      alert('タスクの保存に失敗しました');
    }
  };

  // 目標編集を開く
  const openEditGoal = (goal: Goal) => {
    setEditingGoal(goal);
    setEditForm({
      title: goal.title,
      description: goal.description || '',
      deadline: goal.deadline ? goal.deadline.split('T')[0] : '',
      category: goal.category || 'work_study'
    });
  };

  // 目標編集を保存
  const saveEditGoal = async () => {
    if (!editingGoal || !editingGoal.id) {
      alert('エラー: 目標情報が見つかりません');
      return;
    }

    if (!editForm.title.trim()) {
      alert('タイトルを入力してください');
      return;
    }

    try {
      await updateGoal(editingGoal.id, {
        title: editForm.title.trim(),
        description: editForm.description.trim() || undefined,
        deadline: editForm.deadline || null,
        category: editForm.category
      });

      alert('目標を更新しました');
      setEditingGoal(null);
      loadGoals();
    } catch (error) {
      console.error('[Goals] Edit error:', error);
      alert('目標の更新に失敗しました');
    }
  };

  if (loading) {
    return (
      <div className="container">
        <div style={{ textAlign: 'center', padding: 48 }}>
          <div className="spinner" style={{ margin: '0 auto' }}></div>
          <p style={{ marginTop: 16, color: 'var(--muted)' }}>読み込み中...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="container">
      <section className="card" style={{ padding: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h1 style={{ margin: 0, fontSize: 20 }}>AIゴールプランナー</h1>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              className="btn"
              onClick={startAddGoal}
              style={{ fontSize: 12, padding: '6px 12px' }}
            >
              + 新しい目標
            </button>
            <button
              className="btn secondary"
              onClick={() => setShowImport(true)}
              style={{ fontSize: 12, padding: '6px 12px', background: '#eff6ff', color: '#1e40af', border: '1px solid #3b82f6' }}
            >
              企画書・テキストをインポート
            </button>
          </div>
        </div>

        <p style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 16 }}>
          AIがあなたの目標を分解し、達成までのロードマップを作成します。
        </p>

        {/* 目標リスト */}
        {goals.length === 0 ? (
          <div style={{ 
            textAlign: 'center', 
            padding: 48, 
            background: '#f9fafb', 
            borderRadius: 8,
            border: '1px dashed #d1d5db'
          }}>
            <div style={{ fontSize: 15, fontWeight: 500, marginBottom: 8, color: 'var(--text)' }}>
              まだ目標がありません
            </div>
            <div style={{ fontSize: 13, color: 'var(--muted)' }}>
              「+ 新しい目標」ボタンから目標を作成しましょう
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {goals.map(goal => (
              <div
                key={goal.id}
                className="card"
                style={{
                  padding: 14,
                  background: goal.status === 'active' ? 'white' : '#f9fafb',
                  border: `1px solid ${goal.status === 'active' ? '#a855f7' : '#d1d5db'}`,
                  opacity: goal.status === 'active' ? 1 : 0.6
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                      <strong style={{ fontSize: 14 }}>{goal.title}</strong>
                      <span style={{
                        fontSize: 9,
                        padding: '2px 6px',
                        background: goal.aiSupportLevel === 'auto' ? '#dbeafe' : '#fef3c7',
                        color: goal.aiSupportLevel === 'auto' ? '#1e40af' : '#92400e',
                        borderRadius: 3,
                        fontWeight: 600
                      }}>
                        {goal.aiSupportLevel === 'auto' ? 'おまかせ' : '提案のみ'}
                      </span>
                      {goal.status === 'paused' && (
                        <span style={{
                          fontSize: 9,
                          padding: '2px 6px',
                          background: '#fee2e2',
                          color: '#991b1b',
                          borderRadius: 3,
                          fontWeight: 600
                        }}>
                          一時停止中
                        </span>
                      )}
                    </div>
                    {goal.description && (
                      <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 6 }}>
                        {goal.description}
                      </div>
                    )}
                    {goal.deadline && (
                      <div style={{ fontSize: 11, color: '#dc2626', marginBottom: 6 }}>
                        締切: {format(new Date(goal.deadline), 'yyyy年MM月dd日', { locale: ja })}
                      </div>
                    )}
                    {goal.progress !== undefined && (
                      <div style={{ marginTop: 8 }}>
                        <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 4 }}>
                          進捗: {goal.progress}%
                        </div>
                        <div style={{ 
                          width: '100%', 
                          height: 6, 
                          background: '#e5e7eb', 
                          borderRadius: 3,
                          overflow: 'hidden'
                        }}>
                          <div style={{
                            width: `${goal.progress}%`,
                            height: '100%',
                            background: '#a855f7',
                            transition: 'width 0.3s'
                          }} />
                        </div>
                      </div>
                    )}
                  </div>

                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    <button
                      className="btn secondary"
                      onClick={() => openTaskGenerator(goal)}
                      style={{ fontSize: 10, padding: '4px 8px', background: '#dbeafe', color: '#1e40af', border: '1px solid #3b82f6' }}
                    >
                      タスク生成
                    </button>
                    <button
                      className="btn secondary"
                      onClick={() => openEditGoal(goal)}
                      style={{ fontSize: 10, padding: '4px 8px' }}
                    >
                      編集
                    </button>
                    <button
                      className="btn secondary"
                      onClick={() => toggleGoalStatus(goal)}
                      style={{ fontSize: 10, padding: '4px 8px' }}
                    >
                      {goal.status === 'active' ? '一時停止' : '再開'}
                    </button>
                    <button
                      className="btn secondary"
                      onClick={() => removeGoal(goal.id!)}
                      style={{ fontSize: 10, padding: '4px 8px', background: '#fee2e2', color: '#991b1b' }}
                    >
                      削除
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* AIチャットモーダル（ゴール作成） */}
      {showAddGoal && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: 'rgba(0, 0, 0, 0.5)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 1000,
          padding: 20
        }}>
          <div className="edit-modal-content" style={{
            background: 'var(--card)',
            borderRadius: 12,
            padding: 24,
            maxWidth: 600,
            width: '100%',
            maxHeight: '80vh',
            display: 'flex',
            flexDirection: 'column',
            boxShadow: '0 10px 40px rgba(0,0,0,0.3)'
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h3 style={{ margin: 0 }}>AIゴールプランナー</h3>
              <button
                className="btn secondary"
                onClick={() => setShowAddGoal(false)}
                style={{ fontSize: 12, padding: '4px 8px' }}
              >
                閉じる
              </button>
            </div>

            {/* AIチャット */}
            <div style={{
              flex: 1,
              overflowY: 'auto',
              marginBottom: 16,
              padding: 12,
              background: 'var(--bg)',
              borderRadius: 8,
              display: 'flex',
              flexDirection: 'column',
              gap: 12
            }}>
              {aiChatMessages.map((msg, idx) => (
                <div
                  key={idx}
                  style={{
                    alignSelf: msg.role === 'user' ? 'flex-end' : 'flex-start',
                    maxWidth: '80%'
                  }}
                >
                  <div style={{
                    padding: 10,
                    borderRadius: 8,
                    background: msg.role === 'user' ? '#eff6ff' : 'white',
                    border: `1px solid ${msg.role === 'user' ? '#3b82f6' : '#d1d5db'}`,
                    fontSize: 13,
                    whiteSpace: 'pre-line'
                  }}>
                    {msg.content}
                  </div>
                </div>
              ))}
              {aiProcessing && (
                <div style={{ alignSelf: 'flex-start' }}>
                  <div className="typing">
                    <span></span>
                    <span></span>
                    <span></span>
                  </div>
                </div>
              )}
            </div>

            {/* 入力フォーム */}
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                className="input"
                type="text"
                value={aiChatInput}
                onChange={(e) => setAiChatInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    sendAiMessage();
                  }
                }}
                placeholder="目標や詳細を入力..."
                disabled={aiProcessing}
                style={{ flex: 1, fontSize: 13 }}
              />
              <button
                className="btn"
                onClick={sendAiMessage}
                disabled={aiProcessing || !aiChatInput.trim()}
                style={{ fontSize: 12, padding: '8px 16px' }}
              >
                送信
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 目標編集モーダル */}
      {editingGoal && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: 'rgba(0, 0, 0, 0.5)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 1000,
          padding: 20
        }}>
          <div className="edit-modal-content" style={{
            background: 'var(--card)',
            borderRadius: 12,
            padding: 24,
            maxWidth: 500,
            width: '100%',
            boxShadow: '0 10px 40px rgba(0,0,0,0.3)'
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h3 style={{ margin: 0, fontSize: 18 }}>目標を編集</h3>
              <button
                className="btn secondary"
                onClick={() => setEditingGoal(null)}
                style={{ fontSize: 12, padding: '4px 8px' }}
              >
                閉じる
              </button>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              {/* タイトル */}
              <div>
                <label style={{ display: 'block', marginBottom: 6, fontSize: 13, fontWeight: 600 }}>
                  タイトル <span style={{ color: '#dc2626' }}>*</span>
                </label>
                <input
                  className="input"
                  type="text"
                  value={editForm.title}
                  onChange={(e) => setEditForm({ ...editForm, title: e.target.value })}
                  placeholder="例：基本情報技術者試験 合格"
                  style={{ width: '100%', fontSize: 13 }}
                />
              </div>

              {/* 説明 */}
              <div>
                <label style={{ display: 'block', marginBottom: 6, fontSize: 13, fontWeight: 600 }}>
                  説明
                </label>
                <textarea
                  className="input"
                  value={editForm.description}
                  onChange={(e) => setEditForm({ ...editForm, description: e.target.value })}
                  placeholder="目標の詳細や背景を入力..."
                  style={{ width: '100%', minHeight: 80, fontSize: 13, resize: 'vertical' }}
                />
              </div>

              {/* 締切 */}
              <div>
                <label style={{ display: 'block', marginBottom: 6, fontSize: 13, fontWeight: 600 }}>
                  締切
                </label>
                <input
                  className="input"
                  type="date"
                  value={editForm.deadline}
                  onChange={(e) => setEditForm({ ...editForm, deadline: e.target.value })}
                  style={{ width: '100%', fontSize: 13 }}
                />
              </div>

              {/* カテゴリ */}
              <div>
                <label style={{ display: 'block', marginBottom: 6, fontSize: 13, fontWeight: 600 }}>
                  カテゴリ
                </label>
                <select
                  className="input"
                  value={editForm.category}
                  onChange={(e) => setEditForm({ ...editForm, category: e.target.value as any })}
                  style={{ width: '100%', fontSize: 13 }}
                >
                  <option value="work_study">仕事・勉強</option>
                  <option value="life_chores">生活・家事</option>
                  <option value="leisure">趣味・娯楽</option>
                  <option value="other">その他</option>
                </select>
              </div>
            </div>

            <div style={{ display: 'flex', gap: 8, marginTop: 20, justifyContent: 'flex-end' }}>
              <button
                className="btn secondary"
                onClick={() => setEditingGoal(null)}
                style={{ fontSize: 12, padding: '8px 16px' }}
              >
                キャンセル
              </button>
              <button
                className="btn"
                onClick={saveEditGoal}
                style={{ fontSize: 12, padding: '8px 16px', background: '#a855f7' }}
              >
                保存
              </button>
            </div>
          </div>
        </div>
      )}

      {/* プロジェクトインポートモーダル */}
      {showImport && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: 'rgba(0, 0, 0, 0.5)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 1000,
          padding: 20
        }}>
          <div className="edit-modal-content" style={{
            background: 'var(--card)',
            borderRadius: 12,
            padding: 24,
            maxWidth: 700,
            width: '100%',
            maxHeight: '80vh',
            display: 'flex',
            flexDirection: 'column',
            boxShadow: '0 10px 40px rgba(0,0,0,0.3)'
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h3 style={{ margin: 0, fontSize: 18 }}>プロジェクト・インポーター</h3>
              <button
                className="btn secondary"
                onClick={() => {
                  setShowImport(false);
                  setImportText('');
                  setImportFile(null);
                  setImportResult(null);
                }}
                style={{ fontSize: 12, padding: '4px 8px' }}
              >
                閉じる
              </button>
            </div>

            <p style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 16, lineHeight: 1.6 }}>
              企画書やメール、プロジェクト指示書をコピー＆ペースト、またはファイルアップロードすると、
              AIが自動で「目標」と「タスク」に分解して登録します。
            </p>

            {/* テキスト入力エリア */}
            <div style={{ marginBottom: 16 }}>
              <label style={{ display: 'block', marginBottom: 6, fontSize: 13, fontWeight: 600 }}>
                テキストを貼り付け
              </label>
              <textarea
                className="input"
                value={importText}
                onChange={(e) => setImportText(e.target.value)}
                placeholder="例：&#10;&#10;【AIMO新機能開発プロジェクト】&#10;&#10;期限：2025年11月末&#10;&#10;■ マイルストーン&#10;1. ロードマップ生成機能（11/10まで）&#10;2. LPのワイヤー作成（11/12）&#10;3. デモ動画撮影（11/20）&#10;..."
                disabled={importProcessing}
                style={{
                  width: '100%',
                  minHeight: 200,
                  fontSize: 12,
                  fontFamily: 'monospace',
                  resize: 'vertical'
                }}
              />
            </div>

            {/* ファイルアップロード */}
            <div style={{ marginBottom: 16 }}>
              <label style={{ display: 'block', marginBottom: 6, fontSize: 13, fontWeight: 600 }}>
                またはファイルをアップロード
              </label>
              <div style={{
                border: '2px dashed #d1d5db',
                borderRadius: 8,
                padding: 16,
                textAlign: 'center',
                background: '#f9fafb'
              }}>
                <input
                  type="file"
                  accept=".txt,.pdf,.docx,.doc"
                  onChange={(e) => setImportFile(e.target.files?.[0] || null)}
                  disabled={importProcessing}
                  style={{ fontSize: 12 }}
                />
                {importFile && (
                  <div style={{ marginTop: 8, fontSize: 12, color: 'var(--text)' }}>
                    選択中: {importFile.name}
                  </div>
                )}
                <div style={{ marginTop: 8, fontSize: 11, color: 'var(--muted)' }}>
                  対応形式: .txt, .pdf, .docx, .doc
                </div>
              </div>
            </div>

            {/* 処理中表示 */}
            {importProcessing && (
              <div style={{
                padding: 16,
                background: '#eff6ff',
                border: '1px solid #3b82f6',
                borderRadius: 8,
                marginBottom: 16,
                textAlign: 'center'
              }}>
                <div className="typing" style={{ marginBottom: 8 }}>
                  <span></span>
                  <span></span>
                  <span></span>
                </div>
                <div style={{ fontSize: 12, color: '#1e40af' }}>
                  AIが企画書を解析中...
                </div>
              </div>
            )}

            {/* 実行ボタン */}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button
                className="btn secondary"
                onClick={() => {
                  setShowImport(false);
                  setImportText('');
                  setImportFile(null);
                  setImportResult(null);
                }}
                disabled={importProcessing}
                style={{ fontSize: 12, padding: '8px 16px' }}
              >
                キャンセル
              </button>
              <button
                className="btn"
                onClick={handleImport}
                disabled={importProcessing || (!importText.trim() && !importFile)}
                style={{ fontSize: 12, padding: '8px 16px', background: '#3b82f6' }}
              >
                AIで解析してインポート
              </button>
            </div>
          </div>
        </div>
      )}

      {/* タスク生成モーダル */}
      {showTaskGenerator && selectedGoal && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: 'rgba(0, 0, 0, 0.5)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 1000,
          padding: 20
        }}>
          <div className="edit-modal-content" style={{
            background: 'var(--card)',
            borderRadius: 12,
            padding: 0,
            maxWidth: 800,
            width: '100%',
            maxHeight: '85vh',
            display: 'flex',
            flexDirection: 'column',
            boxShadow: '0 10px 40px rgba(0,0,0,0.3)',
            overflow: 'hidden'
          }}>
            {/* ヘッダー（固定） */}
            <div style={{
              padding: '16px 20px',
              borderBottom: '1px solid var(--border)',
              flexShrink: 0
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h3 style={{ margin: 0, fontSize: 16 }}>タスク生成：{selectedGoal.title}</h3>
                <button
                  className="btn secondary"
                  onClick={() => {
                    setShowTaskGenerator(false);
                    setSelectedGoal(null);
                    setSuggestedTasks([]);
                    setSelectedTaskIndices(new Set());
                  }}
                  style={{ fontSize: 11, padding: '4px 8px' }}
                >
                  閉じる
                </button>
              </div>
            </div>

            {/* スクロール可能なコンテンツエリア */}
            <div style={{
              flex: 1,
              overflowY: 'auto',
              padding: '16px 20px'
            }}>
              {/* 目標情報 */}
              <div style={{
                padding: 12,
                background: '#f9fafb',
                borderRadius: 6,
                marginBottom: 12,
                fontSize: 12
              }}>
                <div style={{ fontWeight: 600, marginBottom: 4 }}>{selectedGoal.title}</div>
                {selectedGoal.description && (
                  <div style={{ color: 'var(--muted)', marginBottom: 4 }}>{selectedGoal.description}</div>
                )}
                {selectedGoal.deadline && (
                  <div style={{ color: '#dc2626', fontSize: 11 }}>
                    締切: {format(new Date(selectedGoal.deadline), 'yyyy年MM月dd日', { locale: ja })}
                  </div>
                )}
                {selectedGoal.progress !== undefined && (
                  <div style={{ marginTop: 6 }}>
                    <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 2 }}>
                      進捗: {selectedGoal.progress}%
                    </div>
                    <div style={{ 
                      width: '100%', 
                      height: 4, 
                      background: '#e5e7eb', 
                      borderRadius: 2,
                      overflow: 'hidden'
                    }}>
                      <div style={{
                        width: `${selectedGoal.progress}%`,
                        height: '100%',
                        background: '#a855f7'
                      }} />
                    </div>
                  </div>
                )}
              </div>

              {/* AI調整入力 */}
              <div style={{ marginBottom: 12 }}>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <span style={{ fontSize: 11, color: '#6b7280', flexShrink: 0 }}>AI調整:</span>
                  <input
                    className="input"
                    type="text"
                    value={taskGenerationPrompt}
                    onChange={(e) => setTaskGenerationPrompt(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                        e.preventDefault();
                        handleGenerateTasks();
                      }
                    }}
                    placeholder="より具体的に / もっと細かく / 技術的なタスクに注力"
                    disabled={generatingTasks}
                    style={{ flex: 1, fontSize: 11, padding: 6 }}
                  />
                  <button
                    className="btn"
                    onClick={handleGenerateTasks}
                    disabled={generatingTasks || !taskGenerationPrompt.trim()}
                    style={{ fontSize: 10, padding: '6px 10px', whiteSpace: 'nowrap' }}
                  >
                    {generatingTasks ? '生成中...' : '再生成'}
                  </button>
                </div>
              </div>

              {/* タスク一覧 */}
              <div style={{ marginBottom: 10 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                  <label style={{ margin: 0, fontSize: 13, fontWeight: 600 }}>
                    生成されたタスク（{selectedTaskIndices.size}/{suggestedTasks.length}）
                  </label>
                  <div style={{ display: 'flex', gap: 4 }}>
                    <button
                      className="btn secondary"
                      onClick={() => setSelectedTaskIndices(new Set(suggestedTasks.map((_, i) => i)))}
                      style={{ fontSize: 10, padding: '3px 6px' }}
                    >
                      すべて
                    </button>
                    <button
                      className="btn secondary"
                      onClick={() => setSelectedTaskIndices(new Set())}
                      style={{ fontSize: 10, padding: '3px 6px' }}
                    >
                      解除
                    </button>
                  </div>
                </div>

                {generatingTasks ? (
                  <div style={{
                    padding: 16,
                    textAlign: 'center',
                    color: '#6b7280',
                    background: '#f9fafb',
                    borderRadius: 6,
                    fontSize: 12
                  }}>
                    AIがタスクを生成中...
                    <div className="typing" style={{ marginTop: 8 }}>
                      <span></span>
                      <span></span>
                      <span></span>
                    </div>
                  </div>
                ) : suggestedTasks.length === 0 ? (
                  <div style={{
                    padding: 16,
                    textAlign: 'center',
                    color: '#6b7280',
                    background: '#f9fafb',
                    borderRadius: 6,
                    fontSize: 12
                  }}>
                    タスクが生成されていません
                  </div>
                ) : (
                  <div style={{ display: 'grid', gap: 4 }}>
                    {suggestedTasks.map((task, index) => (
                      <div
                        key={index}
                        style={{
                          display: 'flex',
                          alignItems: 'flex-start',
                          gap: 6,
                          padding: 8,
                          background: selectedTaskIndices.has(index) 
                            ? (task.isParent ? '#f0fdf4' : '#dbeafe')
                            : (task.isParent ? '#fef3c7' : 'white'),
                          borderRadius: 4,
                          border: `1px solid ${selectedTaskIndices.has(index) 
                            ? (task.isParent ? '#10b981' : '#3b82f6')
                            : (task.isParent ? '#f59e0b' : '#d1d5db')}`,
                          transition: 'all 0.2s'
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={selectedTaskIndices.has(index)}
                          onChange={() => toggleTaskSelection(index)}
                          style={{ width: 16, height: 16, cursor: 'pointer', flexShrink: 0, marginTop: 2 }}
                        />
                        <div style={{ flex: 1 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                            {task.isParent && (
                              <span style={{
                                fontSize: 9,
                                padding: '2px 6px',
                                background: '#f59e0b',
                                color: 'white',
                                borderRadius: 3,
                                fontWeight: 600
                              }}>
                                親タスク
                              </span>
                            )}
                            <div style={{ fontSize: 12, fontWeight: task.isParent ? 600 : 500 }}>
                              {task.title}
                            </div>
                          </div>
                          {task.description && (
                            <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 2 }}>
                              {task.description}
                            </div>
                          )}
                          {task.dueDate && (
                            <div style={{ fontSize: 10, color: '#dc2626' }}>
                              期限: {format(new Date(task.dueDate), 'yyyy/MM/dd', { locale: ja })}
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* フッター（固定） */}
            <div style={{
              padding: '10px 20px',
              borderTop: '1px solid var(--border)',
              flexShrink: 0,
              background: 'var(--card)'
            }}>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  className="btn"
                  onClick={saveGeneratedTasks}
                  disabled={selectedTaskIndices.size === 0}
                  style={{
                    flex: 1,
                    fontSize: 12,
                    padding: '10px 16px',
                    background: selectedTaskIndices.size === 0 ? '#d1d5db' : '#3b82f6'
                  }}
                >
                  {selectedTaskIndices.size > 0
                    ? `選択した${selectedTaskIndices.size}個をタスクに追加`
                    : 'チェックして追加'}
                </button>
                <button
                  className="btn secondary"
                  onClick={() => {
                    setShowTaskGenerator(false);
                    setSelectedGoal(null);
                    setSuggestedTasks([]);
                    setSelectedTaskIndices(new Set());
                  }}
                  style={{ fontSize: 12, padding: '10px 16px' }}
                >
                  キャンセル
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* AIサポートレベル選択モーダル */}
      {showAISupportModal && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: 'rgba(0, 0, 0, 0.7)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 1001,
          padding: 20
        }}>
          <div className="edit-modal-content" style={{
            background: 'var(--card)',
            borderRadius: 12,
            padding: 24,
            maxWidth: 500,
            width: '100%',
            boxShadow: '0 10px 40px rgba(0,0,0,0.3)'
          }}>
            <h3 style={{ margin: '0 0 16px 0', fontSize: 18 }}>AIのサポート方法を選択</h3>
            
            <p style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 20 }}>
              {importResult ? (
                <>
                  「{importResult.goal.title}」をインポートしました。<br />
                  AIのサポート方法をお選びください。
                </>
              ) : (
                <>
                  「{newGoalTitle}」の目標について、AIのサポート方法をお選びください。
                </>
              )}
            </p>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 20 }}>
              {/* おまかせ（auto） */}
              <label style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 12,
                padding: 16,
                border: `2px solid ${selectedAiSupportLevel === 'auto' ? '#a855f7' : '#d1d5db'}`,
                borderRadius: 8,
                background: selectedAiSupportLevel === 'auto' ? '#faf5ff' : 'white',
                cursor: 'pointer',
                transition: 'all 0.2s'
              }}>
                <input
                  type="radio"
                  name="aiSupportLevel"
                  checked={selectedAiSupportLevel === 'auto'}
                  onChange={() => setSelectedAiSupportLevel('auto')}
                  style={{ marginTop: 2 }}
                />
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>
                    おまかせ（AIが自動スケジューリング）
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5 }}>
                    AIMOが「Todayビュー」の空き時間に、この目標の「AI集中時間」を<strong>自動で組み込みます</strong>。
                    締め切りが近い場合、AIが優先的にスケジューリングします。
                  </div>
                </div>
              </label>

              {/* 提案のみ（suggest） */}
              <label style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 12,
                padding: 16,
                border: `2px solid ${selectedAiSupportLevel === 'suggest' ? '#f59e0b' : '#d1d5db'}`,
                borderRadius: 8,
                background: selectedAiSupportLevel === 'suggest' ? '#fffbeb' : 'white',
                cursor: 'pointer',
                transition: 'all 0.2s'
              }}>
                <input
                  type="radio"
                  name="aiSupportLevel"
                  checked={selectedAiSupportLevel === 'suggest'}
                  onChange={() => setSelectedAiSupportLevel('suggest')}
                  style={{ marginTop: 2 }}
                />
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>
                    提案のみ（スケジュールは組まない）
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5 }}>
                    AIMOはタスクの分解や、今日やるべきことの<strong>提案のみ</strong>行います。
                    「Todayビュー」のタイムラインには自動で組み込まず、ユーザーが手動でスケジューリングします。
                  </div>
                </div>
              </label>
            </div>

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button
                className="btn secondary"
                onClick={() => setShowAISupportModal(false)}
                style={{ fontSize: 12, padding: '8px 16px' }}
              >
                戻る
              </button>
              <button
                className="btn"
                onClick={importResult ? saveImportedProject : saveGoal}
                style={{ fontSize: 12, padding: '8px 16px', background: '#a855f7' }}
              >
                {importResult ? 'この設定でインポートを完了' : 'この設定で目標を作成'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

