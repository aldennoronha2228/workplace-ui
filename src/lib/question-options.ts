import type { ProjectQuestion } from '../components/ui/project-questions'

export function withAIChoice(question: ProjectQuestion): ProjectQuestion {
  const options = question.options.filter(option => option.id !== 'ai_choose' && !/^let (?:the )?ai choose$/i.test(option.label.trim()))
  const choice = { id: 'ai_choose', label: 'Let AI choose', description: 'Let the AI select a suitable option for this project using supported components.' }
  return { ...question, options: [...options.slice(0, 3), choice] }
}
